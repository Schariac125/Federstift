import type { KbService } from './service';
import { newStyle } from './service';
import type { StyleEntry } from './types';
import { ask, askConfirm, askMultiline, divider } from '../cli/interactive';
import type { LLMClientLike } from '../core/llm';

export interface StyleAnalysis {
  rules: string[];
  summary: string;
}

/** 基于范例文本的规则式分析（不联网也能用） */
export function analyzeExample(text: string): StyleAnalysis {
  const rules: string[] = [];
  const sentences = text
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const avgLen = sentences.length
    ? Math.round(sentences.reduce((a, s) => a + s.length, 0) / sentences.length)
    : 0;

  // 人称视角
  const first = (text.match(/[我我们]/g) ?? []).length;
  const third = (text.match(/[他她它他们她们]/g) ?? []).length;
  if (first > third * 1.2) rules.push('使用第一人称叙述（"我"的视角）');
  else if (third > 0) rules.push('使用第三人称叙述');

  // 句子长短
  if (avgLen > 0) {
    if (avgLen <= 14) rules.push(`句子短促有力（平均约 ${avgLen} 字）`);
    else if (avgLen >= 26) rules.push(`句子绵长舒缓（平均约 ${avgLen} 字）`);
    else rules.push(`句子长短适中（平均约 ${avgLen} 字）`);
  }

  // 对话占比
  const dialogueMatches = (text.match(/[“”「」]/g) ?? []).length;
  if (dialogueMatches > 0) {
    const ratio = Math.min(99, Math.round((dialogueMatches / 2 / Math.max(1, sentences.length)) * 100));
    if (ratio >= 30) rules.push(`对话占比高（约 ${ratio}%），以对白推动情节`);
    else if (ratio >= 10) rules.push(`对话与叙述均衡（约 ${ratio}% 对话）`);
  }

  // 氛围关键词
  const moodMap: [string, string[]][] = [
    ['冷峻克制', ['冷', '沉默', '面无表情', '暗', '灰']],
    ['温暖细腻', ['暖', '微笑', '温柔', '光', '轻柔']],
    ['悬疑紧张', ['疑', '惊', '忽然', '猛地', '屏住']],
    ['诙谐轻松', ['笑', '打趣', '眨了眨眼', '调侃']],
    ['抒情诗意', ['月光', '风', '叶', '影', '叹息', '远方']],
  ];
  for (const [label, kws] of moodMap) {
    if (kws.some((k) => text.includes(k))) {
      rules.push(`氛围倾向：${label}`);
      break;
    }
  }

  // 标点节奏
  const dash = (text.match(/——/g) ?? []).length;
  if (dash > 0) rules.push('善用破折号制造停顿与补充说明');

  const summary = sentences.length
    ? `共 ${sentences.length} 个句子，平均句长 ${avgLen} 字。`
    : '范例文本过短，建议粘贴 100 字以上的样例。';
  return { rules, summary };
}

const LLM_ANALYSIS_SYSTEM = `你是一位资深文学编辑。请分析用户提供的范例文本，输出**严格 JSON**，不要输出任何其他内容。格式示例：
{"summary":"一句话概括该文风","rules":["规则1（可执行、可校验）","规则2"]}
要求：rules 为 3-8 条可直接执行的写作规则，涉及视角、句长、用词、节奏、对话风格、氛围等维度。`;

export async function analyzeStyleWithLLM(
  llm: LLMClientLike,
  exampleText: string
): Promise<StyleAnalysis | null> {
  try {
    const data = await llm.json<{ summary?: string; rules?: string[] }>(
      LLM_ANALYSIS_SYSTEM,
      `范例文本：\n\n${exampleText.slice(0, 4000)}`
    );
    const rules = (data.rules ?? []).filter((r) => typeof r === 'string' && r.trim());
    if (!rules.length) return null;
    return { summary: data.summary ?? '', rules };
  } catch (e) {
    console.log('（AI 分析失败，将使用本地规则分析）' + (e instanceof Error ? e.message : ''));
    return null;
  }
}

/** 范例式创建风格库：粘贴喜欢的段落 → 提炼成可复用风格 */
export async function createStyleFromExample(
  service: KbService,
  llm?: LLMClientLike
): Promise<StyleEntry | null> {
  divider('范例式创建 · 风格库');
  console.log('把你喜欢的段落粘贴进来（自己写的、别人授权的样例都可以），');
  console.log('我们会提炼成可复用的写作规则，之后每次创作都会自动遵守。\n');

  const name = (await ask('给这个风格起个名字（如：冷峻悬疑风）')).trim();
  if (!name) {
    console.log('未输入名字，已取消。');
    return null;
  }

  const exampleText = await askMultiline('粘贴范例文本', '粘贴全文后，输入 END 单独一行结束');
  if (!exampleText) {
    console.log('没有范例，已取消。');
    return null;
  }

  let analysis = analyzeExample(exampleText);
  console.log('\n—— 规则式分析 ——');
  console.log(analysis.summary);

  // 有真实模型时提供 AI 精修（演示模式自动跳过）
  if (llm && !llm.isDemo) {
    const useAi = await askConfirm('是否让 AI 进一步精修风格分析？', true);
    if (useAi) {
      const ai = await analyzeStyleWithLLM(llm, exampleText);
      if (ai) analysis = ai;
    }
  }

  divider('提炼出的风格规则');
  analysis.rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log('\n可直接编辑：输入「a 规则内容」新增，输入「d 序号」删除，回车 = 全部保留');
  const rules = [...analysis.rules];
  while (true) {
    const cmd = (await ask('')).trim();
    if (!cmd) break;
    if (cmd.startsWith('a ') || cmd.startsWith('A ')) {
      rules.push(cmd.slice(2).trim());
    } else if (cmd.startsWith('d ') || cmd.startsWith('D ')) {
      const idx = parseInt(cmd.slice(2).trim(), 10) - 1;
      if (idx >= 0 && idx < rules.length) rules.splice(idx, 1);
      else console.log('序号无效');
    } else {
      console.log('命令无效（a 新增 / d 删除 / 回车结束）');
    }
  }

  const desc = (await ask('一句话描述这个风格')).trim();
  const tagsRaw = (await ask('标签（逗号分隔，如：悬疑、第一人称）')).trim();
  const tags = tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];

  const entry = newStyle({
    name,
    description: desc || analysis.summary,
    rules,
    exampleText,
    tags,
    source: 'example',
  });

  const ok = await askConfirm('保存这个风格？', true);
  if (!ok) {
    console.log('已取消。');
    return null;
  }
  service.saveStyle(entry);
  console.log(`✔ 已保存到风格库（workspace/styles/${entry.id}.json）`);
  return entry;
}
