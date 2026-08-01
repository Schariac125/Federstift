export type SettingCategory =
  | 'character'
  | 'world'
  | 'plot'
  | 'item'
  | 'timeline'
  | 'other';

export type EntrySource = 'manual' | 'conversation' | 'extracted' | 'example' | 'feedback';

export interface StyleEntry {
  id: string;
  name: string;
  description: string;
  /** 可执行的写作规则（会注入创作 Agent 的约束） */
  rules: string[];
  /** 范例文本：作者认可的样例片段 */
  exampleText: string;
  tags: string[];
  source: EntrySource;
  createdAt: string;
  updatedAt: string;
}

export interface SettingEntry {
  id: string;
  name: string;
  category: SettingCategory;
  /** 自然语言描述（会注入 RAG 索引） */
  content: string;
  /** 不可违背的硬性事实（一致性检查优先引用） */
  facts: string[];
  /** 别名/其他叫法，用于检索与一致性识别 */
  aliases: string[];
  tags: string[];
  source: EntrySource;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateEntry {
  id: string;
  name: string;
  purpose: string;
  /** 提问模板正文，可用 {变量} 占位 */
  prompt: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export const SETTING_CATEGORIES: { value: SettingCategory; label: string }[] = [
  { value: 'character', label: '人物' },
  { value: 'world', label: '世界观/地点' },
  { value: 'plot', label: '剧情/组织' },
  { value: 'item', label: '物品/能力' },
  { value: 'timeline', label: '时间线' },
  { value: 'other', label: '其他' },
];

export function categoryLabel(value: SettingCategory): string {
  return SETTING_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}
