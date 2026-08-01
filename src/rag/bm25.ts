/** 轻量本地检索：中文二元组 + 英文单词切分，BM25 打分（零依赖） */

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 英文/数字单词
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) tokens.push(m[0]);
  // 中文二元组
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk.slice(i, i + 2));
  return tokens;
}

export interface ScoredDoc {
  id: string;
  score: number;
  text: string;
  order?: number;
}

/** 预计算的 BM25 索引：一次分词建索引，多次查询复用（长篇小说章节检索热路径） */
export interface Bm25Index {
  /** 每篇文档的词频表（按 docs 顺序） */
  tfMaps: Map<string, number>[];
  /** 每篇文档的 token 数 */
  lens: number[];
  /** 包含某 token 的文档数 */
  docFreq: Map<string, number>;
  /** 平均文档长度 */
  avgLen: number;
}

export function buildBm25Index(docs: { text: string }[]): Bm25Index {
  const docTokens = docs.map((d) => tokenize(d.text));
  const docFreq = new Map<string, number>();
  for (const ts of docTokens) {
    for (const t of new Set(ts)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const lens = docTokens.map((ts) => ts.length);
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  const tfMaps = docTokens.map((ts) => {
    const m = new Map<string, number>();
    for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  return { tfMaps, lens, docFreq, avgLen };
}

/** 对 query 与 docs 做 BM25 打分，返回前 topK 个文档 id */
export function bm25Top(
  query: string,
  docs: { id: string; text: string }[],
  topK: number,
  k1 = 1.5,
  b = 0.75
): ScoredDoc[] {
  const qTokens = tokenize(query);
  if (!qTokens.length || !docs.length) return [];
  const avgLen = docs.reduce((a, d) => a + tokenize(d.text).length, 0) / docs.length;
  const docFreq = new Map<string, number>();
  const docTokens = docs.map((d) => {
    const ts = tokenize(d.text);
    for (const t of new Set(ts)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    return ts;
  });
  const N = docs.length;
  const scores = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of docTokens[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    const len = docTokens[i].length;
    let score = 0;
    for (const t of new Set(qTokens)) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const df = docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / Math.max(1, avgLen)))));
    }
    return { id: d.id, score, text: d.text, order: (d as { order?: number }).order };
  });
  return scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** 用预计算索引打分（与 bm25Top 打分公式完全一致，但省去每次全量分词/docFreq） */
export function bm25TopIndexed(
  query: string,
  docs: { id: string; text: string; order?: number }[],
  index: Bm25Index,
  topK: number,
  k1 = 1.5,
  b = 0.75
): ScoredDoc[] {
  const qTokens = tokenize(query);
  if (!qTokens.length || !docs.length) return [];
  const qUnique = [...new Set(qTokens)];
  const { tfMaps, lens, docFreq, avgLen } = index;
  const n = docs.length;
  const scores: ScoredDoc[] = [];
  for (let i = 0; i < n; i++) {
    const tf = tfMaps[i];
    const len = lens[i];
    let score = 0;
    for (const t of qUnique) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const df = docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / Math.max(1, avgLen)))));
    }
    if (score > 0) {
      scores.push({ id: docs[i].id, score, text: docs[i].text, order: docs[i].order });
    }
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}
