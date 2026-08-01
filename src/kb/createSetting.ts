import type { KbService } from './service';
import { newSetting } from './service';
import type { SettingEntry, SettingCategory } from './types';
import { SETTING_CATEGORIES, categoryLabel } from './types';
import { ask, askChoice, askConfirm, askMultiline, divider } from '../cli/interactive';

function splitFacts(content: string): string[] {
  return content
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 80);
}

/** 对话式创建设定库条目 */
export async function createSettingConversational(
  service: KbService,
  prefill?: Partial<SettingEntry>
): Promise<SettingEntry | null> {
  divider('对话式创建 · 设定库');
  console.log('我们会用几个简单问题，把一条设定整理成可检索、可校验的条目。');
  console.log('（所有问题都可以直接回车跳过，之后可以随时回来补充）\n');

  const category = await askChoice<SettingCategory>(
    '这条设定属于哪一类？',
    SETTING_CATEGORIES.map((c) => ({ key: c.value, label: c.label, value: c.value })),
    prefill?.category ?? 'character'
  );

  const name = (await ask('给这条设定起个名字', prefill?.name ?? '')).trim();
  if (!name) {
    console.log('未输入名字，已取消。');
    return null;
  }

  const content = await askMultiline(
    `描述一下「${name}」（背景、来历、特点都可以）`,
    '每行一段，输入 END 单独一行结束'
  );
  if (!content) {
    console.log('没有内容，已取消。');
    return null;
  }

  // 从描述中自动拆出候选事实，让作者挑选
  const candidates = splitFacts(content);
  const keep: string[] = [];
  if (candidates.length > 0) {
    console.log('\n检测到以下句子可以作为「硬性事实」（一致性检查会优先遵守）：');
    for (let i = 0; i < candidates.length; i++) {
      console.log(`  ${i + 1}. ${candidates[i]}`);
    }
    const sel = (await ask('要保留哪些？输入序号（逗号分隔），回车 = 全部保留，0 = 都不要', '')).trim();
    if (sel === '0') {
      /* 全不要 */
    } else if (sel === '') {
      keep.push(...candidates);
    } else {
      sel.split(/[,，\s]+/).forEach((n) => {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < candidates.length) keep.push(candidates[idx]);
      });
    }
  }

  const aliasesRaw = (await ask('别名/其他叫法（逗号分隔，便于检索识别）')).trim();
  const aliases = aliasesRaw ? aliasesRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
  const tagsRaw = (await ask('标签（逗号分隔，如：主线、反派）')).trim();
  const tags = tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];

  const entry = newSetting({
    name,
    category,
    content,
    facts: keep.length ? keep : undefined,
    aliases,
    tags,
    source: 'conversation',
  });

  divider('确认保存');
  console.log(`名称：${entry.name}（${categoryLabel(entry.category)}）`);
  console.log(`描述：${entry.content.slice(0, 120)}${entry.content.length > 120 ? '…' : ''}`);
  if (entry.facts.length) {
    console.log('事实：');
    entry.facts.forEach((f) => console.log('  - ' + f));
  }
  if (aliases.length) console.log('别名：' + aliases.join('、'));

  const ok = await askConfirm('保存这条设定？', true);
  if (!ok) {
    console.log('已取消。');
    return null;
  }
  service.saveSetting(entry);
  console.log(`✔ 已保存到设定库（workspace/settings/${entry.id}.json）`);
  return entry;
}
