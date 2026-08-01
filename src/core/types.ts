export type ApprovalMode = 'auto' | 'segment' | 'chapter';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  /** 请求 OpenAI 兼容的 response_format 强制 JSON 输出 */
  jsonMode?: boolean;
}

export interface LLMResult {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** 审查 Agent 的维度 */
export type ReviewDimension =
  | 'plot'
  | 'character'
  | 'settingConsistency'
  | 'style'
  | 'logic'
  | 'language'
  | 'pacing'
  | 'other';
