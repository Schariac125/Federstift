/** 三 Agent 架构的共享类型 */

export interface ChapterPlan {
  order: number;
  title: string;
  /** 本章要达成的叙事目标 */
  goal: string;
  /** 3-6 个情节节拍，创作 Agent 按节拍推进 */
  beats: string[];
  /** 写本章前要问作者的问题（可为空） */
  questions: string[];
  /** 本章结束后是否触发审查 Agent */
  reviewAfter: boolean;
  /** 本章预计段落数 */
  segments: number;
}

export interface CreationPlan {
  /** 对作者创作意图的理解（复述，便于作者校对） */
  premise: string;
  /** 全局创作策略：先写什么、如何推进、情绪曲线 */
  strategy: string;
  /** 风格把控指令（会注入创作 Agent） */
  styleDirectives: string[];
  /** 开局前要问作者的问题（可为空） */
  questions: string[];
  /** 审查时机安排说明 */
  reviewSchedule: string;
  chapters: ChapterPlan[];
}

export interface PlanInput {
  requirement: string;
  styleRules: string[];
  settingsSummary: string;
  approvalMode: string;
  targetChapters: number;
}