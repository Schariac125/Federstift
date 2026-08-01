import * as path from 'node:path';
import { workspaceDir, readJson, writeJson } from './storage';
import type { ApprovalMode } from './types';
import { normalizeStrictness, type ReviewStrictness } from '../agents/reviewer';

export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI 兼容接口根地址（不含 /chat/completions） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否内置预设（可修改但不可删除） */
  builtin?: boolean;
}

export interface RagConfig {
  enabled: boolean;
  topK: number;
  chunkSize: number;
  overlap: number;
}

export interface AppConfig {
  version: number;
  activeProviderId: string;
  providers: ProviderConfig[];
  approvalMode: ApprovalMode;
  /** 每 N 章触发一次宏观一致性检查 */
  macroCheckInterval: number;
  /** 全局默认审查重点（可留空 = 全维度；作品级可覆盖） */
  reviewFocus: string;
  /** 全局默认审查力度（作品级可覆盖） */
  reviewStrictness: ReviewStrictness;
  /** 总规划 Agent 自定义系统提示词（留空 = 使用内置默认） */
  plannerSystemPrompt?: string;
  /** 创作 Agent 自定义系统提示词（留空 = 使用内置默认） */
  writerSystemPrompt?: string;
  rag: RagConfig;
  firstRunDone: boolean;
}

export const PROVIDER_PRESETS: ProviderConfig[] = [
  {
    id: 'demo',
    name: '离线演示模式（无需密钥）',
    baseUrl: '',
    apiKey: '',
    model: 'demo',
    builtin: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    builtin: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    builtin: true,
  },
  {
    id: 'custom',
    name: '自定义（任意 OpenAI 兼容供应商）',
    baseUrl: '',
    apiKey: '',
    model: '',
    builtin: true,
  },
];

export function configPath(): string {
  return path.join(workspaceDir(), 'config.json');
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    activeProviderId: 'demo',
    providers: PROVIDER_PRESETS.map((p) => ({ ...p })),
    approvalMode: 'auto',
    macroCheckInterval: 5,
    reviewFocus: '',
    reviewStrictness: 'standard',
    rag: { enabled: true, topK: 4, chunkSize: 600, overlap: 80 },
    firstRunDone: false,
  };
}

export function loadConfig(): AppConfig {
  const cfg = readJson<AppConfig>(configPath(), defaultConfig());
  // 保证预设始终存在（即使配置文件是旧版本）
  for (const preset of PROVIDER_PRESETS) {
    if (!cfg.providers.some((p) => p.id === preset.id)) {
      cfg.providers.push({ ...preset });
    }
  }
  // 兼容旧版本配置：缺失字段补默认值
  if (cfg.reviewFocus === undefined) cfg.reviewFocus = '';
  if (cfg.reviewStrictness === undefined) cfg.reviewStrictness = 'standard';
  if (cfg.plannerSystemPrompt === undefined) cfg.plannerSystemPrompt = '';
  if (cfg.writerSystemPrompt === undefined) cfg.writerSystemPrompt = '';
  // 默认激活第一个有密钥的供应商，否则回退 demo
  if (!cfg.providers.some((p) => p.id === cfg.activeProviderId)) {
    cfg.activeProviderId = cfg.providers.find((p) => p.apiKey)?.id ?? 'demo';
  }
  return cfg;
}

export function saveConfig(cfg: AppConfig): void {
  writeJson(configPath(), cfg);
}

export function getActiveProvider(cfg: AppConfig): ProviderConfig {
  const p = cfg.providers.find((x) => x.id === cfg.activeProviderId);
  return p ?? cfg.providers.find((x) => x.id === 'demo') ?? cfg.providers[0];
}

export function setProviderApiKey(cfg: AppConfig, providerId: string, apiKey: string): void {
  const p = cfg.providers.find((x) => x.id === providerId);
  if (p) {
    p.apiKey = apiKey.trim();
    if (p.apiKey) cfg.activeProviderId = p.id;
    saveConfig(cfg);
  }
}

export function setProviderModel(cfg: AppConfig, providerId: string, model: string): void {
  const p = cfg.providers.find((x) => x.id === providerId);
  if (p) {
    p.model = model.trim() || p.model;
    saveConfig(cfg);
  }
}

export function setCustomProvider(cfg: AppConfig, baseUrl: string, apiKey: string, model: string): void {
  const p = cfg.providers.find((x) => x.id === 'custom');
  if (p) {
    p.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    p.apiKey = apiKey.trim();
    p.model = model.trim();
    if (p.apiKey) cfg.activeProviderId = 'custom';
    saveConfig(cfg);
  }
}

export function setApprovalMode(cfg: AppConfig, mode: ApprovalMode): void {
  cfg.approvalMode = mode;
  saveConfig(cfg);
}

export function setReviewFocus(cfg: AppConfig, focus: string): void {
  cfg.reviewFocus = focus.trim();
  saveConfig(cfg);
}

export function setReviewStrictness(cfg: AppConfig, strictness: ReviewStrictness): void {
  cfg.reviewStrictness = normalizeStrictness(strictness);
  saveConfig(cfg);
}
