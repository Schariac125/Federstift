import type { ProviderConfig } from './config';
import type { LLMMessage, LLMOptions, LLMResult, ReviewDimension } from './types';
import { logger } from './logger';

export interface LLMClientLike {
  readonly providerId: string;
  readonly isDemo: boolean;
  chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResult>;
  /** 流式生成：逐块回调增量文本（用于 GUI 实时显示正文） */
  chatStream(messages: LLMMessage[], onChunk: (delta: string) => void, opts?: LLMOptions): Promise<LLMResult>;
  /** 强制 JSON 输出：解析失败时自动修复重试 */
  json<T>(system: string, user: string, opts?: LLMOptions): Promise<T>;
}

/** 运行时 fetch 响应（规避不完整的全局类型定义） */
interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body?: AsyncIterable<Uint8Array> | null;
}

/** 从模型回复中提取第一个完整 JSON 对象 */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  // 去掉 markdown 代码围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('回复中未找到 JSON 对象');
  }
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // 常见修复：去掉尾随逗号
    const fixed = candidate.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  }
}

/** OpenAI 兼容 HTTP 客户端 */
export class LLMClient implements LLMClientLike {
  readonly providerId: string;
  readonly isDemo = false;

  constructor(private provider: ProviderConfig) {
    this.providerId = provider.id;
  }

  async chat(messages: LLMMessage[], opts: LLMOptions = {}): Promise<LLMResult> {
    const base = this.provider.baseUrl.replace(/\/+$/, '');
    if (!base) throw new Error(`供应商 ${this.provider.name} 未配置接口地址`);
    if (!this.provider.apiKey) throw new Error(`供应商 ${this.provider.name} 未配置 API Key`);

    const body: Record<string, unknown> = {
      model: this.provider.model,
      messages,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    logger.debug(`LLM -> ${base}/chat/completions (model=${this.provider.model})`);
    const resp = (await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.provider.apiKey}`,
      },
      body: JSON.stringify(body),
    })) as unknown as HttpResponseLike;

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`API 请求失败 (${resp.status}): ${detail.slice(0, 400)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('API 返回了空内容');
    return {
      text,
      model: this.provider.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async json<T>(system: string, user: string, opts: LLMOptions = {}): Promise<T> {
    const result = await this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { ...opts, jsonMode: true, temperature: opts.temperature ?? 0.3 }
    );
    return extractJson(result.text) as T;
  }

  /** 流式对话：按 SSE 增量回调，返回拼接后的完整文本 */
  async chatStream(messages: LLMMessage[], onChunk: (delta: string) => void, opts: LLMOptions = {}): Promise<LLMResult> {
    const base = this.provider.baseUrl.replace(/\/+$/, '');
    if (!base) throw new Error(`供应商 ${this.provider.name} 未配置接口地址`);
    if (!this.provider.apiKey) throw new Error(`供应商 ${this.provider.name} 未配置 API Key`);

    const body: Record<string, unknown> = {
      model: this.provider.model,
      messages,
      temperature: opts.temperature ?? 0.7,
      stream: true,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    logger.debug(`LLM stream -> ${base}/chat/completions (model=${this.provider.model})`);
    const resp = (await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.provider.apiKey}`,
      },
      body: JSON.stringify(body),
    })) as unknown as HttpResponseLike;

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`API 请求失败 (${resp.status}): ${detail.slice(0, 400)}`);
    }
    if (!resp.body) {
      // 供应商不支持流式返回：退化为一次性生成
      return this.chat(messages, opts);
    }

    const decoder = new TextDecoder('utf-8');
    let full = '';
    let buffer = '';
    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const data = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          onChunk(delta);
          full += delta;
        }
      } catch {
        // 忽略无法解析的行（部分供应商会夹杂注释行）
      }
    };
    for await (const chunk of resp.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);

    if (!full) throw new Error('API 流式返回了空内容');
    return { text: full, model: this.provider.model };
  }
}

/** 离线演示模式：不联网，用启发式内容让作者体验完整流程 */
export class DemoLLM implements LLMClientLike {
  readonly providerId = 'demo';
  readonly isDemo = true;

  async chat(_messages: LLMMessage[], _opts: LLMOptions = {}): Promise<LLMResult> {
    const last = _messages[_messages.length - 1]?.content ?? '';
    return { text: this.demoText(last), model: 'demo' };
  }

  async chatStream(_messages: LLMMessage[], onChunk: (delta: string) => void, _opts: LLMOptions = {}): Promise<LLMResult> {
    const last = _messages[_messages.length - 1]?.content ?? '';
    const text = this.demoText(last);
    const slice = Math.max(1, Math.ceil(text.length / 12));
    let i = 0;
    while (i < text.length) {
      onChunk(text.slice(i, i + slice));
      i += slice;
      await sleep(15); // 打字机节奏；降低后演示模式每段固定延迟从 ~0.5s 降至 ~0.18s
    }
    return { text, model: 'demo' };
  }

  async json<T>(system: string, user: string, _opts: LLMOptions = {}): Promise<T> {
    return JSON.parse(this.demoJson(system + '\n' + user)) as T;
  }

  private demoJson(user: string): string {
    if (user.includes('重写方案')) {
      // 演示：重写方案规划师输出示例方案，让作者在无模型时也能看到「先出方案再逐段落实」的效果
      return JSON.stringify({
        approach: '保持原结构与已确认优点，只修正审查指出的问题：第1段统一佩剑描写为左手剑，第2段精简拖沓对白，结尾保留悬念钩子。',
        segments: [
          { order: 1, fix: '把「右手拔剑」改为「左手拔剑」，与设定库保持一致' },
          { order: 2, fix: '精简对白，把关键信息前置，删去重复交代' }
        ]
      });
    }
    if (user.includes('诊断')) {
      // 演示：反复返工诊断（总规划 Agent P1b）
      return JSON.stringify({
        diagnosis: '演示诊断：问题不在文笔，而是本章目标与审查重点错位——创作 Agent 按节奏推进，但审查要求突出悬念。建议重写方案把「悬念前置」作为硬约束。',
        focus: ['把悬念揭示推迟到章末', '删去重复交代的线索']
      });
    }
    if (user.includes('计划') || user.includes('创作意图') || user.includes('策略') || user.includes('strategy') || user.includes('outline')) {
      return JSON.stringify({
        premise: '一个关于剑士的悬念式开篇故事。',
        strategy: '从主角视角开场，先抛出谜团，再逐步展开世界观；情绪曲线前紧后松，每章末留钩子。',
        styleDirectives: ['语言凝练，多用感官细节', '对话推动情节，少用直白心理描写'],
        questions: ['主角最渴望/最害怕什么？'],
        reviewSchedule: '每章轻量自查，每 5 章宏观一致性检查',
        chapters: [
          { order: 1, title: '开场', goal: '引入主角与核心悬念', beats: ['雨夜抵达', '发现异常', '决定追查'], questions: ['主角的性格底色是什么？'], reviewAfter: true, segments: 4 },
          { order: 2, title: '线索', goal: '展开世界观一角', beats: ['接触关键人物', '得到线索', '遭遇阻力'], questions: [], reviewAfter: false, segments: 4 }
        ]
      });
    }
    if (user.includes('偏好') || user.includes('feedback') || user.includes('preference')) {
      return JSON.stringify({
        preferences: [
          { rule: '句子更短促，多用短句', reason: '演示：作者把长句拆短', confidence: 0.8 },
          { rule: '减少直白心理描写，用动作暗示情绪', reason: '演示：作者把心理独白改为动作', confidence: 0.7 }
        ]
      });
    }
    if (user.includes('审查') || user.includes('review') || user.includes('一致')) {
      // 演示：按「本次审查重点」生成针对性示例问题，便于作者在无模型时看到自定义效果
      const focus = user.split('【本次审查重点（请优先、加权检查以下内容）】')[1]?.split('\n')[0].trim() ?? '';
      let dimension: ReviewDimension = 'style';
      let description = '示例问题：部分句子偏长，建议拆分。';
      let suggestion = '把超过 40 字的句子拆成两句。';
      if (/设定|一致/.test(focus)) {
        dimension = 'settingConsistency';
        description = '示例问题：本章对主角佩剑的描写与设定库冲突（设定为左手剑，正文写右手拔剑）。';
        suggestion = '统一为左手剑，或同步修改设定库并说明原因。';
      } else if (/人物|角色|人设|动机/.test(focus)) {
        dimension = 'character';
        description = '示例问题：主角在本章的退让与先前建立的性格底色不一致，动机交代不足。';
        suggestion = '补一句内心权衡，让退让有动机支撑。';
      } else if (/文风|风格/.test(focus)) {
        dimension = 'style';
        description = '示例问题：本章有两处超过 40 字的长句，与风格库「句子短促」的要求冲突。';
        suggestion = '拆分长句，保持短促节奏。';
      } else if (/节奏/.test(focus)) {
        dimension = 'pacing';
        description = '示例问题：本章中段节奏拖沓，同一信息重复交代两次。';
        suggestion = '删去重复交代，把关键事件提前。';
      } else if (/逻辑/.test(focus)) {
        dimension = 'logic';
        description = '示例问题：主角雨夜进入客栈，下一段却已写到天光大亮，缺时间过渡。';
        suggestion = '补充时间推进的过渡句。';
      } else if (/语言/.test(focus)) {
        dimension = 'language';
        description = '示例问题：有两处错别字与一处重复用词。';
        suggestion = '逐句校对修正。';
      } else if (/情节|剧情|悬念/.test(focus)) {
        dimension = 'plot';
        description = '示例问题：本章悬念在段首即被揭开，张力过早释放。';
        suggestion = '把揭示推迟到章末，保留钩子。';
      }
      // 演示：按「审查力度」调整示例报告的严格程度
      const strictness = user.includes('【审查力度】严格') ? 'strict' : user.includes('【审查力度】宽松') ? 'lenient' : 'standard';
      if (strictness === 'lenient') {
        return JSON.stringify({
          passed: true,
          score: { overall: 88, plot: 88, character: 90, settingConsistency: 92, style: 84, logic: 88, language: 90, pacing: 86 },
          issues: [],
          strengths: ['设定引用准确，行文流畅'],
          suggestions: [],
          action: 'ignore',
          targetSegments: []
        });
      }
      const issues =
        strictness === 'strict'
          ? [
              { severity: 'error', dimension, description, suggestion },
              { severity: 'warning', dimension: 'pacing', description: '示例问题：第二段对白略显拖沓，信息密度偏低。', suggestion: '精简对白，把关键信息前置。' }
            ]
          : [{ severity: 'warning', dimension, description, suggestion }];
      return JSON.stringify({
        passed: strictness !== 'strict',
        score:
          strictness === 'strict'
            ? { overall: 58, plot: 55, character: 60, settingConsistency: 65, style: 50, logic: 60, language: 65, pacing: 55 }
            : { overall: 72, plot: 70, character: 75, settingConsistency: 80, style: 65, logic: 70, language: 75, pacing: 70 },
        issues,
        strengths: ['设定引用准确'],
        suggestions: [],
        action: strictness === 'strict' ? 'rewrite' : 'patch',
        targetSegments: strictness === 'strict' ? [] : [2]
      });
    }
    return JSON.stringify({});
  }

  private demoText(prompt: string): string {
    // 从提示里取出关键词，生成一段占位正文（明确标注为演示）
    const keywords = (prompt.match(/[\u4e00-\u9fa5]{2,6}/g) ?? []).slice(0, 6);
    const kw = keywords.length ? keywords.join('、') : '这个世界';
    return `（演示模式）夜色像墨一样漫过窗棂，${kw} 的气息还留在方才的对白里。他沉默了片刻，指尖抵住书页边缘——有些答案，只能由自己来寻找。\n\n风从走廊尽头灌进来，灯影摇晃了一下。故事，就从这里开始。`;
  }
}

export function createLLM(provider: ProviderConfig): LLMClientLike {
  if (provider.id === 'demo' || !provider.apiKey) {
    return new DemoLLM();
  }
  return new LLMClient(provider);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
