import * as path from 'node:path';
import * as fs from 'node:fs';
import { kbDir, newId, nowIso, readJson, writeJson } from '../core/storage';
import type { ApprovalMode } from '../core/types';
import type { CreationPlan } from '../agents/types';
import { normalizeStrictness, type ReviewReport, type ReviewStrictness } from '../agents/reviewer';

export interface ReviewRecord {
  id: string;
  kind: 'chapter' | 'macro';
  chapter: number;
  passed: boolean;
  score: ReviewReport['score'];
  issues: ReviewReport['issues'];
  strengths: string[];
  suggestions: string[];
  ts: string;
}

export interface AuthorNote {
  /** 对应章节（0 表示开局前） */
  chapter: number;
  question: string;
  answer: string;
  ts: string;
}

export interface ChapterSegment {
  order: number;
  text: string;
  /** 用户是否手动修改过 */
  userEdited?: boolean;
  /** 修改前的原文（供反馈学习） */
  original?: string;
}

export interface Chapter {
  order: number;
  title: string;
  segments: ChapterSegment[];
}

export interface NovelState {
  id: string;
  title: string;
  requirement: string;
  approvalMode: ApprovalMode;
  selectedStyleIds: string[];
  selectedSettingIds: string[];
  selectedTemplateIds: string[];
  chapters: Chapter[];
  /** 总规划 Agent 的创作计划 */
  plan?: CreationPlan;
  /** 作者期望的计划总章数 */
  planTarget?: number;
  /** 作者对规划问题的答复（视为设定注入 RAG） */
  authorNotes: AuthorNote[];
  /** 作品级审查重点（可留空，回落全局设置；空则默认全维度） */
  reviewFocus?: string;
  /** 作品级审查力度（可留空，回落全局默认） */
  reviewStrictness?: ReviewStrictness;
  /** 审查记录（章节审查 + 宏观一致性检查） */
  reviews: ReviewRecord[];
  /** 已增量镜像到 manuscript.md 的段落数（热路径增量保存的游标；旧存档由 loadNovel 补齐） */
  manuscriptSegments?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Windows 文件夹名安全化：去掉非法字符、结尾的点/空格、控制字符，并规避保留设备名。
 */
function sanitizeFolderName(name: string): string {
  let s = String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!s) s = 'novel';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s;
}

/** 用标题生成不重复的作品文件夹名（同名作品自动追加 -2、-3 …） */
function uniqueNovelId(title: string): string {
  const dir = kbDir('novels');
  const base = sanitizeFolderName(title);
  let candidate = base;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = base + '-' + i;
    i++;
  }
  return candidate;
}

export function novelDir(id: string): string {
  return path.join(kbDir('novels'), id);
}

export function sessionPath(id: string): string {
  return path.join(novelDir(id), 'session.json');
}

export function manuscriptPath(id: string): string {
  return path.join(novelDir(id), 'manuscript.md');
}

export function newNovel(partial: Partial<NovelState>): NovelState {
  const now = nowIso();
  const rawTitle = (partial.title ?? '').trim();
  // 作者给了标题 → 以标题命名作品文件夹（同名自动加序号）；未给标题 → 保持随机 id 命名
  const useTitle = Boolean(rawTitle) && rawTitle !== '未命名作品';
  const id = useTitle ? uniqueNovelId(rawTitle) : newId('novel');
  return {
    id,
    title: rawTitle || '未命名作品',
    requirement: partial.requirement ?? '',
    approvalMode: partial.approvalMode ?? 'auto',
    selectedStyleIds: partial.selectedStyleIds ?? [],
    selectedSettingIds: partial.selectedSettingIds ?? [],
    selectedTemplateIds: partial.selectedTemplateIds ?? [],
    chapters: partial.chapters ?? [],
    plan: partial.plan,
    planTarget: partial.planTarget,
    authorNotes: partial.authorNotes ?? [],
    reviewFocus: partial.reviewFocus,
    reviewStrictness: partial.reviewStrictness ? normalizeStrictness(partial.reviewStrictness) : undefined,
    reviews: partial.reviews ?? [],
    manuscriptSegments: partial.manuscriptSegments ?? 0,
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}

export function saveNovel(state: NovelState): void {
  state.updatedAt = nowIso();
  writeManuscript(state); // 先全量重建稿子并重置游标，再落盘 session.json
  writeJson(sessionPath(state.id), state);
  if (state.plan) writePlanMd(state);
  writeReviewsMd(state);
}

export interface SaveDeltaOpts {
  /** plan 已更新：重写 plan.md */
  plan?: boolean;
  /** reviews 已更新：重写 reviews.md */
  reviews?: boolean;
}

/**
 * 热路径保存（每段完成时调用）：
 * session.json 全量写（状态快照）+ manuscript.md 增量追加；
 * plan.md / reviews.md 仅在对应内容变化时按需重写（opts 控制），
 * 避免长篇小说每段全量重排整本稿子。
 */
export function saveNovelDelta(state: NovelState, opts?: SaveDeltaOpts): void {
  state.updatedAt = nowIso();
  appendManuscriptDelta(state); // 先同步镜像游标，再落盘 session.json，保证存档内游标一致
  writeJson(sessionPath(state.id), state);
  if (opts?.plan) writePlanMd(state);
  if (opts?.reviews) writeReviewsMd(state);
}

function countSegments(state: NovelState): number {
  let n = 0;
  for (const ch of state.chapters) n += ch.segments.length;
  return n;
}

/** 把 state 中尚未镜像到 manuscript.md 的段落增量追加（新章节先补标题），并同步镜像游标 */
function appendManuscriptDelta(state: NovelState): void {
  const file = manuscriptPath(state.id);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    // 文件缺失/为空：回退全量，保证文件头（标题/要求）完整
    writeManuscript(state);
    return;
  }
  const target = countSegments(state);
  let idx = state.manuscriptSegments ?? 0;
  if (idx >= target) return;
  const parts: string[] = [];
  let global = 0;
  for (const ch of state.chapters) {
    const segs = ch.segments;
    for (let i = 0; i < segs.length; i++) {
      if (global >= idx) {
        if (i === 0) {
          // 新章节的第一个段：先补章节标题（文件以 \n 结尾，前缀 \n 即空行）
          parts.push('\n## ' + ch.title + '\n\n' + segs[i].text + '\n');
        } else {
          parts.push('\n' + segs[i].text + '\n');
        }
      }
      global++;
    }
  }
  fs.appendFileSync(file, parts.join(''), 'utf8');
  state.manuscriptSegments = target;
}

/** 把章节正文渲染成 Markdown 稿子（作者可随时用任何编辑器打开） */
export function writeManuscript(state: NovelState): void {
  const lines: string[] = [`# ${state.title}`, '']
  if (state.requirement) {
    lines.push(`> 创作要求：${state.requirement}`, '')
  }
  for (const ch of state.chapters) {
    lines.push(`## ${ch.title}`, '')
    for (const seg of ch.segments) {
      lines.push(seg.text, '')
    }
  }
  writeManuscriptText(state.id, lines.join('\n'));
  state.manuscriptSegments = countSegments(state);
}

/** 把审查记录写成可读的 reviews.md */
export function writeReviewsMd(state: NovelState): void {
  if (!state.reviews.length) return;
  const lines: string[] = ['# 审查记录', ''];
  for (const r of state.reviews) {
    const kind = r.kind === 'macro' ? '宏观一致性检查' : '章节审查';
    lines.push('## ' + kind + ' · 第 ' + r.chapter + ' 章 · ' + r.ts.slice(0, 16).replace('T', ' '));
    lines.push('');
    lines.push('总分 ' + r.score.overall + '，' + (r.passed ? '通过' : '未通过（存在 error 级问题）'));
    lines.push('');
    lines.push('评分：情节 ' + r.score.plot + ' · 人物 ' + r.score.character + ' · 设定一致 ' + r.score.settingConsistency + ' · 文风 ' + r.score.style + ' · 逻辑 ' + r.score.logic + ' · 语言 ' + r.score.language + ' · 节奏 ' + r.score.pacing);
    lines.push('');
    for (const i of r.issues) {
      const tag = i.severity === 'error' ? '✘' : i.severity === 'warning' ? '!' : '·';
      lines.push(tag + ' [' + i.dimension + '] ' + i.description);
      if (i.suggestion) lines.push('    建议：' + i.suggestion);
    }
    if (r.strengths.length) lines.push('', '优点：' + r.strengths.join('；'));
    if (r.suggestions.length) lines.push('', '整体建议：' + r.suggestions.join('；'));
    lines.push('');
  }
  const file = path.join(novelDir(state.id), 'reviews.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

/**
 * 宏观一致性检查的输入文本：全书章节目录 + 最近 N 章完整正文 + 开篇基础章节选。
 * 长篇小说不可能全量送入审查，因此按「全局结构 + 最新进展 + 故事根基」组合；
 * 超出预算时从尾部裁剪：开篇节选最先被裁，最近章节尽量完整保留。
 */
export function buildMacroCheckText(
  chapters: Chapter[],
  opts?: { recentCount?: number; openingBudget?: number; maxChars?: number }
): string {
  const recentCount = Math.max(1, opts?.recentCount ?? 3);
  const openingBudget = Math.max(0, opts?.openingBudget ?? 1200);
  const maxChars = Math.max(1000, opts?.maxChars ?? 12000);
  if (!chapters.length) return '';

  const parts: string[] = [];
  parts.push('【全书结构】');
  for (const ch of chapters) parts.push('第 ' + ch.order + ' 章 ' + ch.title);

  const recent = chapters.slice(-recentCount);
  for (const ch of recent) {
    parts.push('【第 ' + ch.order + ' 章 · ' + ch.title + '】');
    for (const seg of ch.segments) parts.push(seg.text);
  }

  const first = chapters[0];
  if (!recent.includes(first)) {
    parts.push('【开篇（第 ' + first.order + ' 章 · ' + first.title + '，节选）】');
    parts.push(
      first.segments
        .map((s) => s.text)
        .join('\n')
        .slice(0, openingBudget)
    );
  }

  const out = parts.join('\n\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/** 把创作计划写成可读的 plan.md（作者可校对/修改策略） */
export function writePlanMd(state: NovelState): void {
  const plan = state.plan;
  if (!plan) return;
  const lines: string[] = [
    '# 创作计划',
    '',
    '> 理解：' + plan.premise,
    '',
    '## 全局策略',
    '',
    plan.strategy,
    '',
    '## 风格把控',
    '',
    ...plan.styleDirectives.map((d) => '- ' + d),
    '',
    '## 审查时机',
    '',
    plan.reviewSchedule,
    '',
    '## 章节计划',
    '',
    ...plan.chapters.map((c) => {
      const beats = c.beats.map((b) => '    - ' + b).join('\n');
      return (
        '- 第 ' + c.order + ' 章「' + c.title + '」' +
        (c.reviewAfter ? '（章末审查）' : '') +
        '\n    ' + c.goal +
        (beats ? '\n' + beats : '') +
        (c.questions.length ? '\n    待确认问题：' + c.questions.join(' / ') : '')
      );
    }),
    '',
  ];
  const file = path.join(novelDir(state.id), 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function writeManuscriptText(id: string, content: string): void {
  const file = manuscriptPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function loadNovel(id: string): NovelState | null {
  const n = readJson<NovelState | null>(sessionPath(id), null);
  if (!n) return null;
  // 续写前重同步：以 state 为准全量重建 manuscript.md，
  // 消除崩溃窗口（session/manuscript 双写先后）与旧存档游标缺失造成的不一致
  writeManuscript(n);
  return n;
}

export function listNovels(): NovelState[] {
  return fs.readdirSync(kbDir('novels'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson<NovelState | null>(sessionPath(d.name), null))
    .filter((n): n is NovelState => Boolean(n))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 追加正文到 manuscript.md（与 session.json 双写，崩溃不丢稿） */
/** 删除作品：删除其作品文件夹（session.json/manuscript.md/plan.md/reviews.md）；返回是否确实删除 */
export function deleteNovel(id: string): boolean {
  const dir = novelDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function appendSegmentToManuscript(id: string, segmentText: string): void {
  appendTextFile(manuscriptPath(id), segmentText);
}

function appendTextFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
}