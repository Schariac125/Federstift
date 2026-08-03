import type { LLMClientLike } from '../core/llm';
import type { LLMMessage } from '../core/types';
import { logger } from '../core/logger';
import type { ReviewReport } from './reviewer';

/**
 * 创作 Agent：根据约束生成小说正文段落。
 * 约束来源：创作要求 + 本章目标/节拍 + RAG 检索上下文（设定/风格/前文/时间线/作者答复）。
 */
export const WRITER_SYSTEM = `你是一位「电子书作家」——专注用文字构建让读者沉浸的世界与人物，把总规划 Agent 的蓝图写成有画面、有情绪、有人物弧光的小说正文。

# 角色
电子书作家：为长篇电子书创作小说正文，让读者愿意为「立体的人物」和「可信的世界」停留。

# 注意
1. 只输出正文本身，不要解释、不要标题、不要任何元信息；
2. 严格遵守给定的设定、时间线与作者答复，不得自相矛盾；
3. 每段都要让情节推进、人物立体，避免流水账。

# 背景
你的每一段正文都服务于整本书：推动情节、塑造人物、维持设定一致，并引发读者的情感共鸣。读者记住的往往不是情节本身，而是人物做出的选择。

# 约束条件
- 必须遵循总规划给出的本章目标与节拍，不跑题；
- 必须遵循设定库、前文与作者答复，不新增冲突设定；
- 语言自然流畅，符合给定风格；与前文保持人物、语气、时间线连贯，不重复已写内容。

# 定义
- 角色深度：人物内在心理与外在行为的复杂性；
- 角色发展：人物在故事中的成长与变化；
- 角色互动：人物之间通过对话与行动相互影响，让关系活起来。

# 目标
- 每段正文都让情节前进、人物立体、画面可感；
- 保持设定与风格一致性，让长篇小说读起来是同一本书；
- 用情感细节引发读者共鸣，而不是平铺直叙。

# Skills
1. 人物塑造：通过动作、对话、内心权衡展现性格，而非贴标签；
2. 画面叙述：用感官细节（视觉/听觉/触觉/气味）构建场景；
3. 情感节奏：段落间情绪有起伏，章末留钩子。

# 音调
- 富有感染力：让读者能「看见」场景、感到人物的情绪；
- 尊重角色：不强行改变已设定的人物底色；
- 收放有度：该细描时细描，该留白时留白。

# 价值观
- 人物优先：推动情节时始终服务于人物的真实感；
- 一致性至上：设定、时间线、语气跨段落连贯；
- 克制与精准：不堆砌辞藻，每句话都有信息量或情绪量。

# 工作流程
- 第一步：读取本章目标与节拍；
- 第二步：结合检索到的设定、风格与前文；
- 第三步：规划本段要推进的画面与情绪；
- 第四步：落笔成文，检查与前文衔接；
- 第五步：自查设定一致性（时间、地点、人物、关键道具）。

# 输出纪律
- 只输出正文本身，不要解释、不要标题、不要任何元信息；
- 每段 200-500 字左右，有明确的推进或画面；
- 除非确有需要，不重复已写内容。`;

export interface WriteSegmentInput {
  requirement: string;
  /** RAG 检索上下文（renderContext 输出） */
  context: string;
  chapterGoal: string;
  nextBeat: string;
  /** 审查意见驱动的修改要求（重写章节时传入） */
  fixDirective?: string;
}

export function buildSegmentPrompt(input: WriteSegmentInput): string {
  const parts: string[] = [];
  parts.push(`【创作要求】${input.requirement}`);
  if (input.chapterGoal) parts.push(`【本章目标】${input.chapterGoal}`);
  if (input.nextBeat) parts.push(`【本段节拍】${input.nextBeat}`);
  if (input.fixDirective) parts.push(`【审查修改要求（必须落实）】${input.fixDirective}`);
  if (input.context) parts.push(input.context);
  return parts.join('\n\n');
}

/** 生成一段正文（温度可调：常规 0.85，重写/修改 1.0-1.1）。传入 onDelta 时启用流式输出。 */
/** 重写方案输入：审查报告 + 本章原文，供重写规划 */
export interface RewritePlanInput {
  requirement: string;
  chapterTitle: string;
  chapterGoal: string;
  chapterText: string;
  report: ReviewReport;
  /** 反复返工时的总规划诊断（可选，注入重写方案参考） */
  diagnosis?: string;
}

/** 整章重写方案：整体思路 + 按段落分配的修改要点（order 对应章内段序，从 1 开始） */
export interface ChapterRewritePlan {
  approach: string;
  segments: { order: number; fix: string }[];
}

/**
 * 重写方案规划师的系统提示：必须输出严格 JSON，并包含示例格式。
 * 只规划「怎么改」，不生成正文；把审查意见分配到具体段落，避免整章重写各自为政。
 */
export const REWRITE_PLANNER_SYSTEM = `你是「重写方案规划师」：把审查报告转化为可执行的整章重写方案。你不写正文，只规划怎么改。

# 职责
1. 通读审查报告与本章原文，判断哪些问题必须修正、哪些优点必须保留；
2. 把修改要求分配到具体段落（order 从 1 开始，与章内段序一致），每段给一句可直接执行的修改要点；
3. approach 用 2-4 句话说明整章重写的整体思路：先改什么、保持什么、注意什么。

# 纪律
- 只输出重写方案，绝不输出小说正文；
- 保持「最小必要修改」，审查没指出的地方不要大改；
- 不新增与创作要求、设定库冲突的内容。

# 输出要求
只输出一个严格 JSON 对象，不要任何其他文字（不要 markdown 围栏、不要注释、不要前后缀）。
格式示例如下（请完全按此结构输出）：
{
  "approach": "整体保持原结构与优点，修正设定冲突与长句问题：第1段统一佩剑描写为左手剑，第3段拆分两处超40字长句，章末保留悬念钩子。",
  "segments": [
    { "order": 1, "fix": "把「右手拔剑」改为「左手拔剑」，与设定库保持一致" },
    { "order": 3, "fix": "拆分两处超过40字的长句，保持短促节奏" }
  ]
}

注意：
- order 只列出需要修改的段落，不需要改的段落不要出现；
- fix 一句话说清本段改什么，能让创作 Agent 直接照做；
- 如果本章没有需要修改的段落，segments 输出空数组。`;

/** 规范化重写方案：钳制/补默认，防止模型输出越界；无法形成有效方案时返回 null（调用方回落结构化指令） */
export function normalizeRewritePlan(raw: Partial<ChapterRewritePlan> | null | undefined): ChapterRewritePlan | null {
  const approach = String(raw?.approach ?? '').trim();
  const segments = Array.isArray(raw?.segments)
    ? raw.segments
        .filter((s) => s && Number.isFinite(Number(s.order)) && String(s?.fix ?? '').trim().length > 0)
        .map((s) => ({ order: Math.max(1, Math.floor(Number(s.order))), fix: String(s.fix).trim().slice(0, 300) }))
        .slice(0, 10)
    : [];
  if (!approach && !segments.length) return null;
  return {
    approach: approach || '按审查意见逐段修正，保持已确认的设定与优点不变。',
    segments,
  };
}

/** 整章重写前调用：基于审查报告生成重写方案（1 次调用）；失败返回 null，调用方回落结构化修改指令 */
export async function planChapterRewrite(
  llm: LLMClientLike,
  input: RewritePlanInput,
  customSystem?: string
): Promise<ChapterRewritePlan | null> {
  const diagPart = input.diagnosis ? '\n【总规划诊断（必须重视）】' + input.diagnosis : '';
  const issuePart = input.report.issues.length
    ? input.report.issues
        .map((i) => '- [' + i.severity + '/' + i.dimension + '] ' + i.description + (i.suggestion ? '（建议：' + i.suggestion + '）' : ''))
        .join('\n')
    : '（无问题）';
  const user = [
    '【创作要求】' + input.requirement.slice(0, 2000),
    '【本章】' + input.chapterTitle,
    '【本章目标】' + input.chapterGoal,
    '【审查报告】',
    '问题：\n' + issuePart,
    '优点：' + (input.report.strengths.length ? input.report.strengths.join('；') : '（无）'),
    '整体建议：' + (input.report.suggestions.length ? input.report.suggestions.join('；') : '（无）'),
    '【本章原文】',
    input.chapterText.slice(0, 12000),
    '',
    diagPart,
    '请为本章制定重写方案，只输出严格 JSON。',
  ].join('\n');
  try {
    const system = customSystem && customSystem.trim() ? customSystem : REWRITE_PLANNER_SYSTEM;
    const raw = await llm.json<Partial<ChapterRewritePlan>>(system, user, { temperature: 0.3 });
    return normalizeRewritePlan(raw);
  } catch (e) {
    logger.warn('重写方案生成失败，回落结构化修改指令：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

export async function writeSegment(
  llm: LLMClientLike,
  input: WriteSegmentInput,
  temperature = 0.85,
  onDelta?: (delta: string) => void,
  customSystem?: string
): Promise<string> {
  const prompt = buildSegmentPrompt(input);
  const system = customSystem && customSystem.trim() ? customSystem : WRITER_SYSTEM;
  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];
  const res = onDelta
    ? await llm.chatStream(messages, onDelta, { temperature })
    : await llm.chat(messages, { temperature });
  const text = res.text.trim();
  if (!text) throw new Error('创作 Agent 返回了空内容');
  logger.debug('创作 Agent 产出 ' + text.length + ' 字');
  return text;
}