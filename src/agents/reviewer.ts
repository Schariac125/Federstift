import type { LLMClientLike } from '../core/llm';
import { logger } from '../core/logger';
import type { ReviewDimension } from '../core/types';

export type ReviewSeverity = 'error' | 'warning' | 'info';

export type ReviewStrictness = 'strict' | 'standard' | 'lenient';

export const STRICTNESS_LABEL: Record<ReviewStrictness, string> = {
  strict: '严格：从严审查，轻微问题（warning/info）也要列出，评分从严',
  standard: '标准：常规审查，只列有价值的问题',
  lenient: '宽松：只报明确影响阅读的重大问题（error），轻微瑕疵不打扰作者，评分从宽',
};

export function normalizeStrictness(v: unknown): ReviewStrictness {
  return v === 'strict' || v === 'lenient' ? v : 'standard';
}

export interface ReviewIssue {
  severity: ReviewSeverity;
  dimension: ReviewDimension;
  description: string;
  suggestion: string;
}

export interface ReviewScore {
  overall: number;
  plot: number;
  character: number;
  settingConsistency: number;
  style: number;
  logic: number;
  language: number;
  pacing: number;
}

/** 审查建议动作：rewrite=整章重写；patch=只重写 targetSegments 指定段落；ignore=记录即可 */
export type ReviewAction = 'rewrite' | 'patch' | 'ignore';

export interface ReviewReport {
  /** 是否通过审查（error 级问题为不通过） */
  passed: boolean;
  /** 建议动作（自动模式由规则裁决兜底；可缺省） */
  action?: ReviewAction;
  /** patch 时指定要重写的段号（从 1 开始，缺省=自动推断） */
  targetSegments?: number[];
  score: ReviewScore;
  issues: ReviewIssue[];
  strengths: string[];
  /** 整体修改建议（供重写章节使用） */
  suggestions: string[];
}

/**
 * 审查 Agent 的系统提示：必须输出严格 JSON，并包含示例格式。
 * 审查 Agent 不修改正文，只负责多维审查与修改建议。
 */
export const REVIEWER_SYSTEM = `你是一位严苛但不啰嗦的小说审查编辑。作者会把刚写好的章节（或全书）交给你，你从多个维度审查并给出可执行的修改建议。

【审查维度】
- plot：情节推进是否有效、有无断裂或拖沓；
- character：人物行为是否符合人设、动机是否可信；
- settingConsistency：是否与设定库冲突（名字、外貌、能力、时间线等）；
- style：文风是否统一、是否符合风格要求；
- logic：前后逻辑是否自洽；
- language：错别字、病句、重复用词；
- pacing：节奏是否合适（该紧则紧、该缓则缓）。

【你的禁忌】
- 不修改正文，只输出审查报告；
- 不虚构问题，拿不准的降级为 warning 或 info；
- 不寒暄、不解释输出规则。

【输出要求】只输出一个严格 JSON 对象，不要输出任何其他文字（不要 markdown 围栏、不要注释、不要前后缀）。
格式示例如下（请完全按此结构输出，字段不可缺失，severity 只能是 error/warning/info，dimension 只能是 plot/character/settingConsistency/style/logic/language/pacing）：
{
  "passed": false,
  "score": {
    "overall": 72,
    "plot": 70,
    "character": 75,
    "settingConsistency": 80,
    "style": 65,
    "logic": 70,
    "language": 75,
    "pacing": 70
  },
  "issues": [
    {
      "severity": "warning",
      "dimension": "style",
      "description": "第三段有两个超过40字的长句，读起来吃力",
      "suggestion": "把长句拆成两句，或在中间加逗号停顿"
    }
  ],
  "strengths": ["设定引用准确，人物对话自然"],
  "suggestions": ["整体建议1", "整体建议2"],
  "action": "patch",
  "targetSegments": [2, 3]
}

注意事项：
- score 各维度为 0-100 整数；
- issues 按严重程度排序，error 优先；
- 没有问题的维度不要硬凑 issue；
- passed = 是否存在 error 级问题（false 表示需要修改）；
- action 取值：rewrite=整章重写；patch=只重写 targetSegments 指定的段落；ignore=无需重写、记录即可；
- targetSegments 只在 action=patch 时给出，段号从 1 开始；拿不准时可以不给，自动模式会按规则兜底。`;

export function normalizeScore(raw: Partial<ReviewScore> | undefined): ReviewScore {
  const clamp = (n: number | undefined, def: number) => {
    const v = Number(n);
    return Number.isNaN(v) ? def : Math.min(100, Math.max(0, Math.round(v)));
  };
  return {
    overall: clamp(raw?.overall, 70),
    plot: clamp(raw?.plot, 70),
    character: clamp(raw?.character, 70),
    settingConsistency: clamp(raw?.settingConsistency, 70),
    style: clamp(raw?.style, 70),
    logic: clamp(raw?.logic, 70),
    language: clamp(raw?.language, 70),
    pacing: clamp(raw?.pacing, 70),
  };
}

const VALID_DIMS: ReviewDimension[] = ['plot', 'character', 'settingConsistency', 'style', 'logic', 'language', 'pacing'];

export function normalizeReview(raw: Partial<ReviewReport> | null): ReviewReport {
  const issues = (Array.isArray(raw?.issues) ? raw.issues : [])
    .filter((i) => i && typeof i.description === 'string')
    .map((i) => ({
      severity: i.severity === 'error' || i.severity === 'warning' || i.severity === 'info' ? i.severity : 'info',
      dimension: VALID_DIMS.includes(i.dimension as ReviewDimension) ? (i.dimension as ReviewDimension) : 'other',
      description: String(i.description ?? '').slice(0, 300),
      suggestion: String(i.suggestion ?? '').slice(0, 300),
    }))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
    .slice(0, 20);
  const score = normalizeScore(raw?.score);
  const hasError = issues.some((i) => i.severity === 'error');
  const action = raw?.action === 'rewrite' || raw?.action === 'patch' || raw?.action === 'ignore' ? raw.action : undefined;
  const targetSegments = Array.isArray(raw?.targetSegments)
    ? [...new Set(raw.targetSegments.map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n) && n >= 1 && n <= 30))]
        .sort((a, b) => a - b)
        .slice(0, 8)
    : [];
  return {
    passed: raw?.passed === undefined ? !hasError : Boolean(raw.passed),
    score,
    issues,
    strengths: (Array.isArray(raw?.strengths) ? raw.strengths : []).map(String).filter(Boolean).slice(0, 8),
    suggestions: (Array.isArray(raw?.suggestions) ? raw.suggestions : []).map(String).filter(Boolean).slice(0, 10),
    action,
    targetSegments,
  };
}

function sevRank(s: ReviewSeverity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

/**
 * 规则层裁决（自动模式用，0 次额外 LLM 调用）：
 * - 有 error 级问题 → 重写（模型给 patch+目标段则定向，否则整章）；
 * - 无 error 时：模型明确 rewrite → 整章；模型明确 patch 且有目标段 → 定向；
 * - 设定一致性 warning 或 warning ≥ 2 → 重写；其余 → ignore（记录继续）。
 */
export function decideReviewAction(report: ReviewReport): ReviewAction {
  const hasError = report.issues.some((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;
  const settingIssues = report.issues.some((i) => i.dimension === 'settingConsistency' && i.severity !== 'info');
  if (hasError) {
    if (report.action === 'patch' && (report.targetSegments?.length ?? 0) > 0) return 'patch';
    return 'rewrite';
  }
  if (report.action === 'rewrite') return 'rewrite';
  if (report.action === 'patch' && (report.targetSegments?.length ?? 0) > 0) return 'patch';
  if (settingIssues || warnings >= 2) return 'rewrite';
  return 'ignore';
}

export interface ReviewInput {
  /** 被审查的文本 */
  text: string;
  /** 本次审查重点（作者自定义，可留空 = 默认全维度） */
  focus?: string;
  /** 创作要求/本章目标 */
  goal: string;
  /** 相关设定摘要（供一致性核对） */
  settingsSummary: string;
  /** 风格规则（供文风核对） */
  styleRules: string[];
  /** 审查范围说明（章节/全书宏观） */
  scope: string;
  /** 审查力度（可留空 = 标准） */
  strictness?: ReviewStrictness;
}

/** 把审查报告渲染成结构化的重写指令（必须修正 / 保持不变 / 整体建议），供整章重写注入 */
export function buildRewriteDirective(report: ReviewReport): string {
  const parts: string[] = [];
  const fixes = report.issues
    .filter((i) => i.severity !== 'info')
    .slice(0, 6)
    .map((i) => '- [' + i.dimension + '] ' + i.description + (i.suggestion ? '（建议：' + i.suggestion + '）' : ''));
  parts.push('【必须修正】');
  parts.push(...(fixes.length ? fixes : ['无（可保持本章结构）']));
  if (report.strengths.length) parts.push('【保持不变】' + report.strengths.slice(0, 3).join('；'));
  if (report.suggestions.length) parts.push('【整体建议】' + report.suggestions.slice(0, 3).join('；'));
  return parts.join('\n');
}

export function buildReviewUser(input: ReviewInput): string {
  const stylePart = input.styleRules.length ? '\n风格要求：\n- ' + input.styleRules.join('\n- ') : '（无风格要求）';
  const settingPart = input.settingsSummary.trim() ? '\n相关设定（用于一致性核对）：\n' + input.settingsSummary : '（无相关设定）';
  const focusPart = input.focus?.trim() ? '\n【本次审查重点（请优先、加权检查以下内容）】' + input.focus.trim() : '';
  const strictness = normalizeStrictness(input.strictness);
  const strictPart = '\n【审查力度】' + STRICTNESS_LABEL[strictness];
  return '【审查范围】' + input.scope + '\n【目标】' + input.goal + focusPart + strictPart + stylePart + settingPart + '\n【待审查文本】\n' + input.text.slice(0, 12000);
}

/** 章节级审查 */
export async function reviewChapter(
  llm: LLMClientLike,
  input: ReviewInput
): Promise<ReviewReport> {
  try {
    const raw = await llm.json<Partial<ReviewReport>>(REVIEWER_SYSTEM, buildReviewUser(input), { temperature: 0.3 });
    logger.info('审查 Agent 输出：' + JSON.stringify(raw).slice(0, 200));
    return normalizeReview(raw);
  } catch (e) {
    logger.warn('审查 Agent 失败，按通过处理：' + (e instanceof Error ? e.message : String(e)));
    return normalizeReview(null);
  }
}

/**
 * 宏观一致性检查：每 N 章触发，把全书与设定库/时间线整体核对。
 * 与章节审查共用同一 JSON 契约，因此调用方可以统一处理。
 */
export async function macroCheck(
  llm: LLMClientLike,
  input: ReviewInput
): Promise<ReviewReport> {
  return reviewChapter(llm, { ...input, scope: '【宏观一致性检查】' + input.scope });
}