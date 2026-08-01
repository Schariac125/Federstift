import type { SettingEntry, StyleEntry } from '../kb/types';
import type { AuthorNote, Chapter } from '../pipeline/novel';
import { bm25Top, bm25TopIndexed, buildBm25Index, type Bm25Index } from './bm25';
import { indexSettings, indexStyles, indexTimeline, indexChapters, indexChapter, indexNotes } from './indexer';
import type { IndexSources, IndexedDoc } from './indexer';

export interface RagQueryCfg {
  topK: number;
  chunkSize: number;
  overlap: number;
}

export interface RetrievalResult {
  settings: SettingEntry[];
  styles: StyleEntry[];
  chapterChunks: { order: number; text: string }[];
  timelineChunks: string[];
  noteChunks: string[];
}

/**
 * 深度 RAG 检索：从设定/风格/已写章节/时间线/作者答复五类来源中，
 * 按 BM25 相关性分别取回，保证长篇设定一致性与前后文连贯。
 */
/** 单章切块 + 该章的 BM25 分量（tfMaps/lens/docFreq 只统计本章，合并时加总） */
export interface ChapterPart {
  fp: string;
  docs: IndexedDoc[];
  bm25: Bm25Index;
}

export interface MergedChapterIndex {
  docs: IndexedDoc[];
  index: Bm25Index;
}

/**
 * 章节索引增量缓存：按章缓存切块与 BM25 分量，
 * 只重建「内容变化的章节」，其余章复用；全局合并结果懒重建。
 * 长篇小说每段只重切当前章（数千字），不再每段全量重切整本（40 万字）。
 */
export interface ChapterIndexCache {
  /** 章号 → 单章内容指纹（段数 + 末段信息；重写/打回会导致变化） */
  chapterFps: Map<number, string>;
  /** 章号 → 单章切块 + BM25 分量 */
  parts: Map<number, ChapterPart>;
  /** 全局合并结果（章节变化时置空，下次检索懒重建） */
  merged: MergedChapterIndex | null;
}

export function newChapterIndexCache(): ChapterIndexCache {
  return { chapterFps: new Map(), parts: new Map(), merged: null };
}

/** 单章指纹：章号 + 段数 + 末段文本长度与尾部（重写/打回会导致指纹变化） */
function chapterPartFp(ch: Chapter): string {
  const last = ch.segments[ch.segments.length - 1];
  return ch.order + ':' + ch.segments.length + ':' + (last ? last.text.length + ':' + last.text.slice(-24) : '');
}

/** 合并逐章分量：docs/tfMaps/lens 按章序拼接，docFreq 逐 token 加总，avgLen 为全局均值 */
function mergeChapterParts(parts: Map<number, ChapterPart>): MergedChapterIndex {
  const orders = [...parts.keys()].sort((a, b) => a - b);
  const docs: IndexedDoc[] = [];
  const tfMaps: Map<string, number>[] = [];
  const lens: number[] = [];
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const o of orders) {
    const p = parts.get(o)!;
    docs.push(...p.docs);
    tfMaps.push(...p.bm25.tfMaps);
    lens.push(...p.bm25.lens);
    totalLen += p.bm25.lens.reduce((a, b) => a + b, 0);
    for (const [t, c] of p.bm25.docFreq) docFreq.set(t, (docFreq.get(t) ?? 0) + c);
  }
  const n = docs.length;
  return { docs, index: { tfMaps, lens, docFreq, avgLen: totalLen / Math.max(1, n) } };
}

/** 构建/复用章节索引：只重算变化的章节 */
function buildChapterIndex(
  chapters: Chapter[],
  cfg: { chunkSize: number; overlap: number },
  cache: ChapterIndexCache | null | undefined
): MergedChapterIndex {
  if (!cache) {
    const docs = indexChapters(chapters, cfg.chunkSize, cfg.overlap);
    return { docs, index: buildBm25Index(docs) };
  }
  const parts = cache.parts;
  const fps = cache.chapterFps;
  const seen = new Set<number>();
  let changed = false;
  for (const ch of chapters) {
    seen.add(ch.order);
    const fp = chapterPartFp(ch);
    const old = parts.get(ch.order);
    if (!old || old.fp !== fp || fps.get(ch.order) !== fp) {
      const docs = indexChapter(ch, cfg.chunkSize, cfg.overlap);
      parts.set(ch.order, { fp, docs, bm25: buildBm25Index(docs) });
      fps.set(ch.order, fp);
      changed = true;
    }
  }
  for (const key of [...parts.keys()]) {
    if (!seen.has(key)) {
      parts.delete(key);
      fps.delete(key);
      changed = true;
    }
  }
  if (changed) cache.merged = null;
  if (!cache.merged) cache.merged = mergeChapterParts(parts);
  return cache.merged;
}

export function buildRagContext(
  query: string,
  sources: IndexSources,
  cfg: RagQueryCfg,
  chapterCache?: ChapterIndexCache | null
): RetrievalResult {
  const q = query || ' ';
  const styleK = Math.max(1, Math.ceil(cfg.topK / 3));

  const settingHits = bm25Top(q, indexSettings(sources.settings), cfg.topK);
  const styleHits = bm25Top(q, indexStyles(sources.styles), styleK);
  // 章节索引增量缓存：只重建内容变化的章节，其余复用；全局合并结果懒重建
  const merged = buildChapterIndex(sources.chapters, cfg, chapterCache);
  const chapterHits = bm25TopIndexed(q, merged.docs, merged.index, cfg.topK);
  const timelineHits = bm25Top(q, indexTimeline(sources.settings), 2);
  const noteHits = bm25Top(q, indexNotes(sources.notes), 2);

  return {
    settings: settingHits
      .map((h) => sources.settings.find((s) => 'set_' + s.id === h.id))
      .filter((s): s is SettingEntry => Boolean(s)),
    styles: styleHits
      .map((h) => sources.styles.find((s) => 'style_' + s.id === h.id))
      .filter((s): s is StyleEntry => Boolean(s)),
    chapterChunks: chapterHits.map((h) => ({ order: h.order ?? 0, text: h.text })),
    timelineChunks: timelineHits.map((h) => h.text),
    noteChunks: noteHits.map((h) => h.text),
  };
}

export function emptyRetrieval(): RetrievalResult {
  return { settings: [], styles: [], chapterChunks: [], timelineChunks: [], noteChunks: [] };
}

/** 把检索结果渲染成注入创作 Agent 的约束文本 */
export function renderContext(retrieved: RetrievalResult, recentText: string): string {
  const parts: string[] = [];
  if (retrieved.settings.length) {
    parts.push('【相关设定（必须严格遵守）】');
    for (const s of retrieved.settings) {
      parts.push('- ' + s.name + '：' + s.content);
      for (const f of s.facts) parts.push('  · 事实：' + f);
      if (s.aliases?.length) parts.push('  · 别名：' + s.aliases.join('、'));
    }
  }
  if (retrieved.timelineChunks.length) {
    parts.push('【时间线约束（不得与既有时间线冲突）】');
    for (const t of retrieved.timelineChunks) parts.push('- ' + t);
  }
  if (retrieved.styles.length) {
    parts.push('【风格要求】');
    for (const s of retrieved.styles) {
      parts.push('- 风格「' + s.name + '」：');
      for (const r of s.rules) parts.push('  · ' + r);
    }
  }
  if (retrieved.noteChunks.length) {
    parts.push('【作者已确认的答复（视为设定）】');
    for (const n of retrieved.noteChunks) parts.push('- ' + n);
  }
  if (retrieved.chapterChunks.length) {
    parts.push('【相关前文细节（保持前后一致）】');
    for (const c of retrieved.chapterChunks) parts.push('- 第 ' + c.order + ' 章：' + c.text);
  }
  if (recentText.trim()) {
    parts.push('【前文（紧邻上下文，保持连贯，不要重复）】');
    parts.push(recentText.trim().slice(-1600));
  }
  return parts.join('\n\n');
}