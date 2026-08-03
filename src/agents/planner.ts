import type { LLMClientLike } from '../core/llm';
import { logger } from '../core/logger';
import type { CreationPlan, PlanInput } from './types';
import type { ReviewReport } from './reviewer';

/**
 * 总规划 Agent 的系统提示：必须输出严格 JSON，并给出示例格式。
 * 规划 Agent 不生成正文、不调用任何工具，只负责全局策略。
 */
export const PLANNER_SYSTEM = `你是一位「长篇叙事总规划师」——作者把整本书的创作意图交给你，你在动笔之前设计全局蓝图，让后续创作有方向、不失控。

# 角色
长篇叙事总规划师：帮助作者把模糊的想法变成清晰、可执行的全局创作蓝图。

# 注意
1. 只做全局策略设计，绝不生成任何小说正文（一个字的正文都不写）；
2. 不虚构作者没有给出的设定事实，设定库内容只可引用、不可新增；
3. 提问要克制：只在信息不足或需要作者拍板时才问，问得精准、一次别太多。

# 背景
电子书创作需要跨章节的长期一致性：人物、设定、情绪与风格都要前后呼应。总规划师在动笔前完成全局设计，避免写到后面失控、返工。

# 约束条件
- 必须遵循作者给定的创作意图与设定，不擅自改变题材和基调；
- 必须规划清楚：先写什么、何时提问、何时审查、风格如何把控；
- 不引用、不解释、不寒暄，只输出规划本身。

# 定义
- 全局策略：先写什么、主线如何推进、情绪曲线如何安排、风格如何把控；
- 提问时机：信息不足或需要作者拍板的关键节点；
- 审查时机：哪些章节需要重点审查、每隔几章做宏观一致性检查。

# 目标
- 精准理解作者意图，制定可执行的全局策略；
- 规划出有张力的章节结构：每章有目标、有节拍、有推进；
- 把「何时提问、何时审查、风格如何把控」安排清楚，让创作过程顺畅、少打断。

# Skills
1. 结构设计：设计首尾呼应、悬念递进的长篇结构；
2. 情绪曲线：安排情绪起伏，让读者保持阅读动力；
3. 一致性规划：提前锁定关键设定与风格规则，减少后续返工。

# 音调
- 克制而专业：只呈现决策与依据，不输出寒暄和情绪词；
- 具体可执行：每条策略都能被创作 Agent 直接照做。

# 价值观
- 尊重作者的创作意图，不擅自改变题材、基调与人物底色；
- 重视跨章节一致性，宁可少问、问得精准；
- 保持克制：规划是地图，不是小说。

# 工作流程
- 第一步：理解创作意图（题材、基调、想表达什么）；
- 第二步：梳理已有设定与风格规则；
- 第三步：设计章节结构与情绪曲线；
- 第四步：安排提问时机与审查时机；
- 第五步：输出全局策略与逐章计划。

# 输出纪律
只输出一个严格 JSON 对象，不要输出任何其他文字（不要 markdown 围栏、不要注释、不要前后缀）。
格式示例如下（请完全按此结构输出，字段不可缺失）：
{
  "premise": "一句话复述你理解的创作意图",
  "strategy": "全局策略：开篇如何切入、主线如何推进、情绪曲线如何安排",
  "styleDirectives": ["可执行的风格指令1", "可执行的风格指令2"],
  "questions": ["开局前需要作者回答的问题1", "问题2"],
  "reviewSchedule": "审查时机安排，如：每章轻量自查，每5章宏观一致性检查",
  "chapters": [
    {
      "order": 1,
      "title": "第1章标题",
      "goal": "本章要达成的叙事目标",
      "beats": ["节拍1：……", "节拍2：……", "节拍3：……"],
      "questions": ["本章需要作者回答的问题（无则空数组）"],
      "reviewAfter": true,
      "segments": 4
    }
  ]
}

注意事项：
- chapters 数量等于作者要求的章数；
- segments 建议 3-6；
- questions 尽量少而精，只在真正需要作者拍板时才出现；
- 不要一次问太多问题，避免打断作者；
- reviewAfter 只在需要重点审查的章节为 true。`;

/** 规范化：补默认值、修剪边界，防止模型输出越界 */
export function normalizePlan(raw: Partial<CreationPlan> | null, targetChapters: number): CreationPlan {
  const chapters = (raw?.chapters ?? []).slice(0, targetChapters).map((c, i) => ({
    order: i + 1,
    title: String(c?.title ?? '第 ' + (i + 1) + ' 章'),
    goal: String(c?.goal ?? '推进主线'),
    beats: Array.isArray(c?.beats) ? c.beats.map(String).filter(Boolean).slice(0, 6) : [],
    questions: Array.isArray(c?.questions) ? c.questions.map(String).filter(Boolean).slice(0, 3) : [],
    reviewAfter: Boolean(c?.reviewAfter),
    segments: Math.min(10, Math.max(2, Number(c?.segments) || 4)),
  }));
  // 章数不足则补足默认章
  while (chapters.length < targetChapters) {
    const i = chapters.length;
    chapters.push({ order: i + 1, title: '第 ' + (i + 1) + ' 章', goal: '推进主线', beats: [], questions: [], reviewAfter: false, segments: 4 });
  }
  return {
    premise: String(raw?.premise ?? ''),
    strategy: String(raw?.strategy ?? '从主角视角开篇，先建立悬念，再逐步展开。'),
    styleDirectives: Array.isArray(raw?.styleDirectives) ? raw.styleDirectives.map(String).filter(Boolean).slice(0, 10) : [],
    questions: Array.isArray(raw?.questions) ? raw.questions.map(String).filter(Boolean).slice(0, 3) : [],
    reviewSchedule: String(raw?.reviewSchedule ?? '每章轻量自查，每 5 章宏观一致性检查'),
    chapters,
  };
}

/** 调用总规划 Agent 生成创作计划 */
export async function planNovel(llm: LLMClientLike, input: PlanInput, customSystem?: string): Promise<CreationPlan> {
  const stylePart = input.styleRules.length ? '\n风格规则：\n- ' + input.styleRules.join('\n- ') : '（作者未提供风格库，按题材常识把握）';
  const settingPart = input.settingsSummary.trim() ? '\n设定库摘要（仅可引用，不可新增）：\n' + input.settingsSummary : '（设定库为空）';
  const user = `【创作意图】
${input.requirement.slice(0, 2000)}

【审批模式】${input.approvalMode}
【要求章数】${input.targetChapters}
【风格把控】${stylePart}
【现有设定】${settingPart}

请制定全局创作策略并输出严格 JSON。`;
  try {
    const system = customSystem && customSystem.trim() ? customSystem : PLANNER_SYSTEM;
    const raw = await llm.json<Partial<CreationPlan>>(system, user, { temperature: 0.3 });
    logger.info('总规划 Agent 输出计划：' + JSON.stringify(raw).slice(0, 200));
    return normalizePlan(raw, input.targetChapters);
  } catch (e) {
    logger.warn('规划 Agent 失败，使用默认计划：' + (e instanceof Error ? e.message : String(e)));
    return normalizePlan(null, input.targetChapters);
  }
}

/**
 * 计划修订（P1）：宏观一致性检查发现跨章/计划级问题时，由总规划 Agent 修订全局策略。
 * 只修订计划、不重写正文；保持章节总数不变，调整后续章节目标与审查安排。
 */
export const PLAN_REVISER_SYSTEM = `你是「长篇叙事总规划师」的修订模式：宏观一致性检查发现当前创作计划存在跨章节/结构性问题，请修订计划，让后续创作回到正轨。

# 职责
1. 通读宏观审查报告与当前计划，判断问题根源（结构、节奏、设定、人物弧线等）；
2. 修订全局策略与后续章节目标；已完成的章节不要列在章节计划里，也不要要求重写已完成正文；
3. 保持章节总数与已完成章节不变。

# 纪律
- 只输出修订后的创作计划（严格 JSON），不输出正文、不解释；
- 不新增与创作要求冲突的内容。

# 输出要求
只输出一个严格 JSON 对象（结构与总规划首次输出一致）：
{
  "premise": "一句话复述创作意图",
  "strategy": "修订后的全局策略（说明原计划哪里出了问题、后续如何调整）",
  "styleDirectives": ["风格指令"],
  "questions": [],
  "reviewSchedule": "修订后的审查安排",
  "chapters": [
    { "order": 1, "title": "章节标题", "goal": "本章目标", "beats": ["节拍"], "questions": [], "reviewAfter": false, "segments": 4 }
  ]
}
注意：chapters 数量必须等于当前计划总章数；已完成的章节 goal/beats 可保留原样。`;

/** 计划修订输入：当前计划 + 宏观审查报告 + 全书进度 */
export interface RevisePlanInput {
  requirement: string;
  plan: CreationPlan;
  report: ReviewReport;
  chaptersSummary: string;
}

/** 调用总规划 Agent 修订创作计划；失败返回 null（调用方保持原计划） */
export async function revisePlan(
  llm: LLMClientLike,
  input: RevisePlanInput,
  customSystem?: string
): Promise<CreationPlan | null> {
  const issuePart = input.report.issues.length
    ? input.report.issues
        .map((i) => '- [' + i.severity + '/' + i.dimension + '] ' + i.description + (i.suggestion ? '（建议：' + i.suggestion + '）' : ''))
        .join('\n')
    : '（无问题）';
  const planPart = input.plan.chapters
    .map((c) => '- 第 ' + c.order + ' 章「' + c.title + '」目标：' + c.goal + (c.reviewAfter ? '（章末审查）' : ''))
    .join('\n');
  const user = [
    '【创作要求】' + input.requirement.slice(0, 2000),
    '【当前进度】' + input.chaptersSummary,
    '【当前计划】',
    planPart,
    '【宏观审查报告】',
    '问题：\n' + issuePart,
    '整体建议：' + (input.report.suggestions.length ? input.report.suggestions.join('；') : '（无）'),
    '',
    '请修订创作计划，保持章节总数不变，只输出严格 JSON。',
  ].join('\n');
  try {
    const system = customSystem && customSystem.trim() ? customSystem : PLAN_REVISER_SYSTEM;
    const raw = await llm.json<Partial<CreationPlan>>(system, user, { temperature: 0.3 });
    return normalizePlan(raw, input.plan.chapters.length);
  } catch (e) {
    logger.warn('计划修订失败，保持原计划：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

/**
 * 返工诊断（P1）：同一章反复重写仍不通过时，由总规划 Agent 诊断「为什么改不好」，
 * 输出新的修改方向，注入下一次重写方案。
 */
export const REWRITE_DIAGNOSTIC_SYSTEM = `你是「长篇叙事总规划师」的诊断模式：某一章反复重写仍未通过审查，请诊断问题根源并给出新的修改方向。你不写正文，只做诊断。

# 职责
1. 对比本章原文、审查报告与之前已尝试的修改要求，找出「改不好」的根源；
2. 判断是正文问题、计划目标问题，还是审查与创作理解偏差；
3. 输出诊断结论与下一步的具体方向。

# 输出要求
只输出一个严格 JSON 对象，不要任何其他文字：
{
  "diagnosis": "2-4 句话说明问题根源与新的修改方向",
  "focus": ["可执行的方向1", "方向2"]
}
注意：diagnosis 要具体可执行，避免空泛建议。`;

/** 返工诊断输入：章原文 + 审查报告 + 已尝试的修改要求 */
export interface DiagnoseRewriteInput {
  requirement: string;
  chapterTitle: string;
  chapterGoal: string;
  chapterText: string;
  report: ReviewReport;
  pastDirectives: string[];
}

/** 调用总规划 Agent 诊断反复返工；失败返回 null（调用方直接按审查意见重写） */
export async function diagnoseRewrite(
  llm: LLMClientLike,
  input: DiagnoseRewriteInput,
  customSystem?: string
): Promise<string | null> {
  const issuePart = input.report.issues
    .map((i) => '- [' + i.severity + '/' + i.dimension + '] ' + i.description + (i.suggestion ? '（建议：' + i.suggestion + '）' : ''))
    .join('\n');
  const past = input.pastDirectives.length ? input.pastDirectives.map((d) => '- ' + d.slice(0, 200)).join('\n') : '（首次诊断）';
  const user = [
    '【创作要求】' + input.requirement.slice(0, 2000),
    '【本章】' + input.chapterTitle,
    '【本章目标】' + input.chapterGoal,
    '【已尝试的修改要求】',
    past,
    '【最近一次审查报告】',
    issuePart,
    '【本章原文】',
    input.chapterText.slice(0, 10000),
    '',
    '请诊断反复重写仍未通过的原因，输出严格 JSON。',
  ].join('\n');
  try {
    const system = customSystem && customSystem.trim() ? customSystem : REWRITE_DIAGNOSTIC_SYSTEM;
    const raw = await llm.json<{ diagnosis?: string }>(system, user, { temperature: 0.3 });
    const d = String(raw?.diagnosis ?? '').trim();
    return d ? d.slice(0, 500) : null;
  } catch (e) {
    logger.warn('返工诊断失败，按审查意见直接重写：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}
