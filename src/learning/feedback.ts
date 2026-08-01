import * as fs from 'node:fs';
import * as path from 'node:path';
import { kbDir, listJsonFiles, nowIso, readJson, writeJson } from '../core/storage';
import { logger } from '../core/logger';
import type { LLMClientLike } from '../core/llm';
import type { KbService } from '../kb/service';
import { newStyle } from '../kb/service';
import type { StyleEntry } from '../kb/types';

export interface FeedbackRecord {
  id: string;
  novelId: string;
  chapter: number;
  segment: number;
  /** AI 原文 */
  original: string;
  /** 作者修改后的版本 */
  edited: string;
  ts: string;
  /** 是否已被反馈学习处理过 */
  processed?: boolean;
  learnedAt?: string;
}

export interface PreferenceCandidate {
  /** 可执行的风格规则 */
  rule: string;
  /** 依据说明 */
  reason: string;
  /** 0-1 */
  confidence: number;
  source: 'rule' | 'llm';
}

function feedbackDir(): string {
  return kbDir('feedback');
}

export function listFeedbackRecords(): FeedbackRecord[] {
  return listJsonFiles(feedbackDir())
    .map((f) => readJson<FeedbackRecord | null>(path.join(feedbackDir(), f), null))
    .filter((r): r is FeedbackRecord => Boolean(r && r.original !== undefined && r.edited !== undefined))
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

export function listUnprocessedFeedback(): FeedbackRecord[] {
  return listFeedbackRecords().filter((r) => !r.processed);
}

export function saveFeedbackRecord(rec: FeedbackRecord): void {
  writeJson(path.join(feedbackDir(), rec.id + '.json'), rec);
}

/** 记录一条用户修改（创作流水线调用） */
export function recordFeedback(rec: FeedbackRecord): void {
  saveFeedbackRecord(rec);
}

/** 标记为已学习 */
export function markFeedbackProcessed(ids: string[]): void {
  const byId = new Map(listFeedbackRecords().map((r) => [r.id, r]));
  for (const id of ids) {
    const rec = byId.get(id);
    if (rec) {
      rec.processed = true;
      rec.learnedAt = nowIso();
      saveFeedbackRecord(rec);
    }
  }
}

/** 删除某部作品的全部反馈记录（作品删除时调用，避免遗留孤儿记录） */
export function deleteFeedbackForNovel(novelId: string): void {
  for (const rec of listFeedbackRecords()) {
    if (rec.novelId === novelId) {
      fs.unlinkSync(path.join(feedbackDir(), rec.id + '.json'));
    }
  }
}

// ---------------- 规则式偏好提炼 ----------------

interface TextStats {
  sentences: string[];
  avgLen: number;
  firstPerson: number;
  thirdPerson: number;
  dialoguePairs: number;
  exclamations: number;
  questions: number;
  dashes: number;
  ellipsis: number;
  toneWords: number;
  length: number;
}

function textStats(text: string): TextStats {
  const sentences = text
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dialoguePairs = (text.match(/[“”「」]/g) ?? []).length / 2;
  return {
    sentences,
    avgLen: sentences.length ? Math.round(text.length / Math.max(1, sentences.length)) : 0,
    firstPerson: (text.match(/[我我们]/g) ?? []).length,
    thirdPerson: (text.match(/[他她它他们她们]/g) ?? []).length,
    dialoguePairs,
    exclamations: (text.match(/[！!]/g) ?? []).length,
    questions: (text.match(/[？?]/g) ?? []).length,
    dashes: (text.match(/——/g) ?? []).length,
    ellipsis: (text.match(/……/g) ?? []).length,
    toneWords: (text.match(/[吗呢啊吧嘛哟]/g) ?? []).length,
    length: text.length,
  };
}

function cand(rule: string, reason: string, confidence: number): PreferenceCandidate {
  return { rule, reason, confidence, source: 'rule' };
}

/** 对比原文与修改，用规则提炼风格偏好（不联网也能用） */
export function analyzeFeedbackRuleBased(original: string, edited: string): PreferenceCandidate[] {
  const a = textStats(original);
  const b = textStats(edited);
  const out: PreferenceCandidate[] = [];
  const both = a.sentences.length > 0 && b.sentences.length > 0;

  if (both && b.avgLen <= a.avgLen - 4) {
    out.push(cand('句子更短促（平均 ' + b.avgLen + ' 字，原文 ' + a.avgLen + ' 字），避免长句', '作者把长句改短', 0.75));
  } else if (both && b.avgLen >= a.avgLen + 4) {
    out.push(cand('句子更绵长舒缓（平均 ' + b.avgLen + ' 字，原文 ' + a.avgLen + ' 字）', '作者把句子改长、放缓节奏', 0.7));
  }
  if (b.firstPerson > a.firstPerson && b.firstPerson > 0) {
    out.push(cand('倾向第一人称叙述（多用\"我\"）', '作者补充了第一人称视角', 0.65));
  }
  if (b.thirdPerson > a.thirdPerson && b.thirdPerson > 0) {
    out.push(cand('倾向第三人称叙述（多用\"他/她\"）', '作者补充了第三人称视角', 0.6));
  }
  if (both && b.dialoguePairs / b.sentences.length > a.dialoguePairs / a.sentences.length + 0.1) {
    out.push(cand('增加对话占比，用对白推动情节', '作者改写了更多对话', 0.7));
  }
  if (b.exclamations > a.exclamations + 1) {
    out.push(cand('情绪更外放：在关键处使用感叹', '作者补充了感叹语气', 0.6));
  }
  if (b.dashes > a.dashes) {
    out.push(cand('善用破折号制造停顿与补充说明', '作者增加了破折号', 0.55));
  }
  if (b.ellipsis > a.ellipsis) {
    out.push(cand('善用省略号留白，克制直白交代', '作者增加了省略号', 0.55));
  }
  if (b.toneWords > a.toneWords + 1) {
    out.push(cand('对话更生活化：适当使用语气词（吗/呢/啊/吧）', '作者增加了语气词', 0.6));
  }
  if (b.length <= a.length * 0.7 && a.length > 40) {
    out.push(cand('精简叙述，删减冗余描写与重复', '作者明显删短了原文', 0.8));
  } else if (b.length >= a.length * 1.3) {
    out.push(cand('扩充细节与感官描写', '作者明显加长了原文', 0.7));
  }
  return out;
}

/** 去掉括号里的具体数字细节，用于近义规则去重（保留更通用的表述） */
export function normalizeRuleKey(rule: string): string {
  return rule.replace(/（[^）]*）/g, '').trim();
}

/** 多记录汇总：按规则文本合并去重，保留最高置信度 */
export function mergeCandidates(all: PreferenceCandidate[]): PreferenceCandidate[] {
  const map = new Map<string, PreferenceCandidate>();
  for (const c of all) {
    const key = normalizeRuleKey(c.rule.trim());
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...c, rule: c.rule.trim() });
    } else {
      prev.confidence = Math.min(1, Math.max(prev.confidence, c.confidence) + 0.08);
      prev.reason = prev.reason + '；' + c.reason;
      // 用更通用的表述替换带数字细节的表述
      if (c.rule.length < prev.rule.length) prev.rule = c.rule.trim();
    }
  }
  return Array.from(map.values())
    .filter((c) => c.confidence >= 0.5)
    .sort((x, y) => y.confidence - x.confidence);
}

// ---------------- LLM 偏好提炼 ----------------

/**
 * 学习 Agent 的系统提示：必须输出严格 JSON，并给出示例格式。
 */
export const LEARNER_SYSTEM = `你是一位文学编辑兼风格分析师。下面给出若干组「AI 原文 → 作者修改后」的对比。请从作者的修改中提炼稳定的写作偏好，用于更新作者的风格库。

【你的职责】
1. 找出反复出现的修改模式（至少出现 2 次，或单次修改意图非常明确）；
2. 把偏好写成**可执行、可校验**的风格规则（如：\"句子更短促，平均 12 字以内\"）；
3. 给出依据（作者具体改了什么）与置信度。

【你的禁忌】
- 不评价文本好坏，只提炼偏好；
- 不输出与修改无关的泛泛建议；
- 不寒暄、不解释。

【输出要求】只输出一个严格 JSON 对象，不要输出任何其他文字（不要 markdown 围栏、不要注释、不要前后缀）。
格式示例：
{
  "preferences": [
    {
      "rule": "句子更短促，平均 12 字以内",
      "reason": "作者把 3 处 30 字以上的长句拆短",
      "confidence": 0.8
    }
  ]
}

注意事项：confidence 为 0-1 数字；preferences 最多 8 条；拿不准的偏好不要输出。`;

export async function analyzeFeedbackWithLLM(
  llm: LLMClientLike,
  records: FeedbackRecord[]
): Promise<PreferenceCandidate[]> {
  if (!records.length) return [];
  const body = records
    .slice(0, 20)
    .map((r, i) => '【第 ' + (i + 1) + ' 组】\n原文：' + r.original.slice(0, 800) + '\n修改：' + r.edited.slice(0, 800))
    .join('\n\n');
  try {
    const raw = await llm.json<{ preferences?: unknown[] }>(LEARNER_SYSTEM, body, { temperature: 0.3 });
    const prefs = (Array.isArray(raw?.preferences) ? raw.preferences : [])
      .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
      .map((p) => ({
        rule: String(p.rule ?? '').trim(),
        reason: String(p.reason ?? '').trim(),
        confidence: Math.min(1, Math.max(0, Number(p.confidence) || 0.5)),
        source: 'llm' as const,
      }))
      .filter((p) => p.rule.length > 0)
      .slice(0, 8);
    logger.info('学习 Agent 提炼 ' + prefs.length + ' 条偏好');
    return prefs;
  } catch (e) {
    logger.warn('学习 Agent 失败：' + (e instanceof Error ? e.message : String(e)));
    return [];
  }
}

// ---------------- 应用到风格库 ----------------

/**
 * 把偏好写入风格库：
 * - targetStyleId 为空 → 新建「从反馈中学习」风格；
 * - 否则追加规则到已有风格（去重）。
 */
export function applyPreferencesToStyle(
  service: KbService,
  targetStyleId: string | null,
  prefs: PreferenceCandidate[],
  newStyleName?: string
): StyleEntry {
  const rules = prefs.map((p) => p.rule.trim()).filter(Boolean);
  if (targetStyleId) {
    const style = service.findStyle(targetStyleId);
    if (!style) throw new Error('目标风格不存在：' + targetStyleId);
    const existing = new Set(style.rules);
    const added = rules.filter((r) => !existing.has(r));
    if (added.length) {
      style.rules = [...style.rules, ...added];
      style.updatedAt = nowIso();
      service.saveStyle(style);
    }
    return style;
  }
  const style = newStyle({
    name: newStyleName ?? '从反馈中学习',
    description: '由作者在创作中的修改反馈提炼而来，可持续更新',
    rules,
    source: 'feedback',
  });
  service.saveStyle(style);
  return style;
}