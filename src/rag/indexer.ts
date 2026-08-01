import type { SettingEntry, StyleEntry } from '../kb/types';
import type { AuthorNote, Chapter } from '../pipeline/novel';

export type DocKind = 'setting' | 'style' | 'timeline' | 'chapter' | 'note';

export interface IndexedDoc {
  id: string;
  kind: DocKind;
  text: string;
  /** 章节类文档记录所属章号，用于回显 */
  order?: number;
}

/** 把长文本切成带重叠的块（优先在句号处断开） */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    const cut = clean.lastIndexOf('。', end);
    if (cut > start + chunkSize * 0.6) end = cut + 1;
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

/** 设定库：整条作为文档（含别名） */
export function indexSettings(settings: SettingEntry[]): IndexedDoc[] {
  return settings.map((s) => ({
    id: 'set_' + s.id,
    kind: 'setting' as const,
    text: [s.name, s.content, ...s.facts, ...(s.aliases ?? [])].join(' '),
  }));
}

/** 风格库：整条作为文档 */
export function indexStyles(styles: StyleEntry[]): IndexedDoc[] {
  return styles.map((s) => ({
    id: 'style_' + s.id,
    kind: 'style' as const,
    text: [s.name, s.description, ...s.rules, s.exampleText].join(' '),
  }));
}

const YEAR_RE = /(\d{3,4}\s*年|公元|纪元|世纪|时代|年前|年间|历法)/;

/** 时间线：设定库中 category=timeline 或含年份线索的条目 */
export function indexTimeline(settings: SettingEntry[]): IndexedDoc[] {
  return settings
    .filter((s) => s.category === 'timeline' || YEAR_RE.test(s.content) || s.facts.some((f) => YEAR_RE.test(f)))
    .map((s) => ({
      id: 'timeline_' + s.id,
      kind: 'timeline' as const,
      text: [s.name, s.content, ...s.facts].join(' '),
    }));
}

/** 单章切块：只处理一章，供增量缓存重建变化章节 */
export function indexChapter(ch: Chapter, chunkSize: number, overlap: number): IndexedDoc[] {
  const text = '第 ' + ch.order + ' 章 ' + ch.title + '\n' + ch.segments.map((s) => s.text).join('\n');
  const out: IndexedDoc[] = [];
  for (const c of chunkText(text, chunkSize, overlap)) {
    out.push({ id: 'ch_' + ch.order + '_' + out.length, kind: 'chapter', text: c, order: ch.order });
  }
  return out;
}

/** 已写章节：逐章切块，供检索远端细节保证一致 */
export function indexChapters(chapters: Chapter[], chunkSize: number, overlap: number): IndexedDoc[] {
  const docs: IndexedDoc[] = [];
  for (const ch of chapters) docs.push(...indexChapter(ch, chunkSize, overlap));
  return docs;
}

/** 作者答复：一问一答作为一条文档，创作时持续生效 */
export function indexNotes(notes: AuthorNote[]): IndexedDoc[] {
  return notes.map((n, i) => ({
    id: 'note_' + i,
    kind: 'note' as const,
    text: '【作者答复】' + n.question + ' → ' + n.answer,
  }));
}

export interface IndexSources {
  settings: SettingEntry[];
  styles: StyleEntry[];
  chapters: Chapter[];
  notes: AuthorNote[];
}

export function buildAllDocs(
  sources: IndexSources,
  cfg: { chunkSize: number; overlap: number }
): IndexedDoc[] {
  return [
    ...indexSettings(sources.settings),
    ...indexStyles(sources.styles),
    ...indexTimeline(sources.settings),
    ...indexChapters(sources.chapters, cfg.chunkSize, cfg.overlap),
    ...indexNotes(sources.notes),
  ];
}