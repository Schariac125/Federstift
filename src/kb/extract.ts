import type { SettingCategory } from './types';

export interface ExtractCandidate {
  name: string;
  category: SettingCategory;
  content: string;
  facts: string[];
  aliases: string[];
  confidence: number;
}

const CATEGORY_KEYWORDS: Record<SettingCategory, string[]> = {
  character: ['他叫', '她叫', '名叫', '是一名', '是一位', '性格', '出生于', '主角', '配角', '女主角', '男主角'],
  world: ['城', '国', '大陆', '世界', '森林', '山脉', '河流', '海', '岛屿', '学院', '王朝', '王国', '帝国', '神殿', '遗迹', '村庄', '帝都', '圣城'],
  plot: ['组织', '势力', '公会', '教团', '宗门', '门派', '战争', '阴谋', '预言', '任务', '事件', '革命', '联盟', '仪式'],
  item: ['剑', '刀', '戒', '法宝', '神器', '药剂', '魔杖', '卷轴', '铠甲', '宝物', '秘籍', '圣物', '符文'],
  timeline: ['公元', '元年', '世纪', '时代', '纪元', '年前', '年间', '历法', '朝代'],
  other: [],
};

const BINDING_VERBS = ['是', '叫', '来自', '出生于', '拥有', '掌握', '生活在', '诞生于'];

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function classify(sentence: string): { category: SettingCategory; score: number } {
  let best: SettingCategory = 'other';
  let bestScore = 0;
  (Object.keys(CATEGORY_KEYWORDS) as SettingCategory[]).forEach((cat) => {
    if (cat === 'other') return;
    const score = CATEGORY_KEYWORDS[cat].reduce(
      (acc, kw) => acc + (sentence.includes(kw) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  });
  return { category: best, score: bestScore };
}

function guessName(sentence: string): string | null {
  for (const verb of BINDING_VERBS) {
    const idx = sentence.indexOf(verb);
    if (idx > 0) {
      const name = sentence.slice(0, idx).replace(/^[\s\d.、，,]+/, '').slice(0, 12).trim();
      if (name.length >= 2) return name;
    }
  }
  return null;
}

/** 从自由文本中自动提取设定候选（规则启发式，无需联网） */
export function extractSettings(text: string): ExtractCandidate[] {
  const sentences = splitSentences(text);
  const seen = new Set<string>();
  const out: ExtractCandidate[] = [];

  for (const sentence of sentences) {
    const { category, score } = classify(sentence);
    if (category === 'other' && score === 0) continue;
    const name = guessName(sentence) ?? sentence.slice(0, 6);
    const key = name + '|' + category;
    if (seen.has(key)) continue;
    seen.add(key);
    // 事实：把含硬性信息的短句直接作为事实
    const facts = sentence.length <= 60 ? [sentence] : [];
    const confidence = Math.min(0.9, 0.4 + score * 0.2 + (facts.length ? 0.15 : 0));
    out.push({ name, category, content: sentence, facts, aliases: [], confidence });
  }
  return out.slice(0, 20);
}
