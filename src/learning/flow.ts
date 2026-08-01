import type { AppConfig } from '../core/config';
import { getActiveProvider } from '../core/config';
import { createLLM } from '../core/llm';
import type { KbService } from '../kb/service';
import { ask, askChoice, askConfirm, divider, pressEnter } from '../cli/interactive';
import {
  analyzeFeedbackRuleBased,
  analyzeFeedbackWithLLM,
  applyPreferencesToStyle,
  listUnprocessedFeedback,
  markFeedbackProcessed,
  mergeCandidates,
} from './feedback';
import type { PreferenceCandidate } from './feedback';

/**
 * 反馈学习交互流程：
 * 读取未学习的修改记录 → 规则式 + 可选 LLM 提炼偏好 → 作者挑选 → 写入风格库（新建/追加）。
 */
export async function feedbackLearnFlow(
  cfg: AppConfig,
  service: KbService
): Promise<void> {
  divider('反馈学习 · 从你的修改中提炼偏好');
  const records = listUnprocessedFeedback();
  if (!records.length) {
    console.log('暂无可学习的修改反馈。');
    console.log('创作时选择「修改这段」，你的修改会被记录到 workspace/feedback/，之后可在这里提炼成风格。');
    await pressEnter();
    return;
  }
  console.log('检测到 ' + records.length + ' 条你在创作中亲手修改的段落（workspace/feedback/）。');
  console.log('目标：从这些修改里提炼你的写作偏好，更新风格库。\n');

  const llm = createLLM(getActiveProvider(cfg));
  let useLlm = false;
  if (!llm.isDemo) {
    useLlm = await askConfirm('让 AI 辅助分析偏好？（规则分析已自动执行，AI 可补充更细致的洞察）', true);
  } else {
    console.log('（当前为演示模式，使用规则分析）');
  }

  // 收集候选偏好
  const ruleCands: PreferenceCandidate[] = [];
  for (const r of records) {
    ruleCands.push(...analyzeFeedbackRuleBased(r.original, r.edited));
  }
  let candidates = mergeCandidates(ruleCands);
  if (useLlm) {
    const llmCands = await analyzeFeedbackWithLLM(llm, records);
    candidates = mergeCandidates([...candidates, ...llmCands]);
  }
  if (!candidates.length) {
    console.log('没有提炼出足够明确的偏好（修改可能偏内容而非风格）。可以继续创作，积累更多修改后再来。');
    await pressEnter();
    return;
  }

  console.log('\n提炼出的候选偏好（按置信度排序）：');
  candidates.forEach((c, i) => {
    console.log('  ' + (i + 1) + '. [' + Math.round(c.confidence * 100) + '%] ' + c.rule + '（' + c.reason + '）');
  });

  const sel = (await ask('要采纳哪些？（逗号分隔序号；输入 a 全选；回车 = 取消）')).trim();
  if (!sel) {
    console.log('已取消。');
    return;
  }
  const idxs: number[] = [];
  if (sel === 'a' || sel === 'A') {
    candidates.forEach((_, i) => idxs.push(i));
  } else {
    sel.split(/[,，\s]+/).forEach((n) => {
      const idx = parseInt(n, 10) - 1;
      if (idx >= 0 && idx < candidates.length) idxs.push(idx);
    });
  }
  if (!idxs.length) {
    console.log('没有选中，已取消。');
    return;
  }
  const chosen = idxs.map((i) => candidates[i]);

  // 目标风格
  const styles = service.listStyles();
  const options = styles.map((s, i) => ({ key: 's' + i, label: '追加到风格「' + s.name + '」', value: s.id }));
  options.push({ key: 'new', label: '新建一个风格', value: 'new' });
  const target = await askChoice<string>('把偏好写到哪里？', options, 'new');
  let applied;
  if (target === 'new') {
    const name = (await ask('新风格的名字', '从反馈中学习')).trim() || '从反馈中学习';
    applied = applyPreferencesToStyle(service, null, chosen, name);
  } else {
    applied = applyPreferencesToStyle(service, target, chosen);
  }
  markFeedbackProcessed(records.map((r) => r.id));
  console.log('✔ 已更新风格库：' + applied.name + '（新增 ' + chosen.length + ' 条规则）');
  console.log('已学习 ' + records.length + ' 条修改记录（下次不会再重复提示）。');
  await pressEnter();
}