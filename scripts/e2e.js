/**
 * 端到端验收：用演示引擎完整走通
 * 知识库 → 总规划 → 深度RAG写作 → 审查(章节+宏观) → 修改反馈 → 反馈学习 → 风格更新
 * 运行：npm run e2e （或 node scripts/e2e.js）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 端到端验收使用独立临时工作区，绝不触碰用户的真实数据（FEDERSTIFT_WORKSPACE 由 storage.workspaceDir 读取）
process.env.FEDERSTIFT_WORKSPACE = path.join(require('node:os').tmpdir(), 'federstift-e2e');
fs.rmSync(process.env.FEDERSTIFT_WORKSPACE, { recursive: true, force: true });

const { loadConfig } = require('../dist/core/config.js');
const { workspaceDir } = require('../dist/core/storage.js');
const { createKbService, newStyle, newSetting } = require('../dist/kb/service.js');
const { planNovel } = require('../dist/agents/planner.js');
const { writeSegment } = require('../dist/agents/writer.js');
const { buildRagContext, renderContext } = require('../dist/rag/context.js');
const { reviewChapter, macroCheck } = require('../dist/agents/reviewer.js');
const { DemoLLM } = require('../dist/core/llm.js');
const { newNovel, saveNovel, loadNovel, novelDir } = require('../dist/pipeline/novel.js');
const {
  analyzeFeedbackRuleBased,
  analyzeFeedbackWithLLM,
  applyPreferencesToStyle,
  listUnprocessedFeedback,
  markFeedbackProcessed,
  mergeCandidates,
  recordFeedback,
} = require('../dist/learning/feedback.js');

const results = [];
function ok(name, detail) { results.push('✔ ' + name + (detail ? '（' + detail + '）' : '')); console.log('  ✔ ' + name + (detail ? '（' + detail + '）' : '')); }
function bad(name, e) { results.push('✘ ' + name + ' -> ' + (e && e.message ? e.message : e)); console.error('  ✘ ' + name + ' -> ' + (e && e.message ? e.message : e)); process.exitCode = 1; }

async function main() {
  const llm = new DemoLLM();
  const cfg = loadConfig();
  const service = createKbService();
  const ws = workspaceDir();

  // ---- 0. 清理历史验收数据 ----
  const novelRoot = path.join(ws, 'novels');
  if (fs.existsSync(novelRoot)) for (const d of fs.readdirSync(novelRoot)) {
    if (d.includes('e2e')) fs.rmSync(path.join(novelRoot, d), { recursive: true, force: true });
  }
  const fbDir = path.join(ws, 'feedback');
  if (fs.existsSync(fbDir)) {
    for (const f of fs.readdirSync(fbDir)) if (f.includes('e2e')) fs.unlinkSync(path.join(fbDir, f));
  }
  for (const s of service.listStyles()) if (s.name.includes('验收')) service.removeStyle(s.id);

  // ---- 1. 知识库 ----
  let style1;
  try {
    const setting1 = newSetting({ name: '主角阿翎', category: 'character', content: '西城剑士，左手剑。', facts: ['阿翎用左手剑'], aliases: ['翎'], source: 'conversation' });
    const setting2 = newSetting({ name: '北境战争', category: 'timeline', content: '公元 1173 年爆发。', facts: ['战争始于 1173 年'], source: 'conversation' });
    style1 = newStyle({ name: '验收冷峻风', rules: ['句子短促'], exampleText: '示例。', source: 'example' });
    service.saveSetting(setting1); service.saveSetting(setting2); service.saveStyle(style1);
    assert.strictEqual(service.listSettings().length, 2);
    ok('知识库就绪', '2 设定 + 1 风格');
  } catch (e) { bad('知识库', e); }

  // ---- 2. 新建作品 + 总规划 ----
  let novel;
  try {
    novel = newNovel({ title: '端到端验收作品', requirement: '剑士阿翎在北境战争中追寻真相，有悬念。', approvalMode: 'auto', planTarget: 2, reviewFocus: '设定一致性', reviewStrictness: 'strict', selectedSettingIds: service.listSettings().map((s) => s.id), selectedStyleIds: [style1.id] });
    const plan = await planNovel(llm, { requirement: novel.requirement, styleRules: style1.rules, settingsSummary: service.listSettings().map((s) => '- ' + s.name).join('\n'), approvalMode: 'auto', targetChapters: 2 });
    novel.plan = plan;
    novel.authorNotes = [{ chapter: 0, question: '主角最怕什么？', answer: '火。', ts: '2026-08-01T00:00:00.000Z' }];
    saveNovel(novel);
    assert.strictEqual(plan.chapters.length, 2, '计划章数异常');
    assert.ok(fs.existsSync(path.join(novelDir(novel.id), 'plan.md')), 'plan.md 缺失');
    ok('总规划 Agent', '2 章计划 + plan.md');
  } catch (e) { bad('总规划', e); }

  // ---- 3. 深度 RAG 写作（模拟流水线） ----
  try {
    const settings = service.listSettings();
    const styles = service.listStyles().filter((s) => novel.selectedStyleIds.includes(s.id));
    cfg.macroCheckInterval = 2; // 演示计划仅第 1 章设章节审查；间隔=2 让第 2 章触发宏观一致性检查，共 2 份报告
    for (const cp of novel.plan.chapters) {
      const chOrder = novel.chapters.length + 1;
      const chapter = { order: chOrder, title: cp.title, segments: [] };
      novel.chapters.push(chapter);
      for (let si = 0; si < cp.segments; si++) {
        const recent = novel.chapters.map((c) => c.segments.map((s) => s.text).join('\n')).join('\n\n');
        const query = [novel.requirement, cp.title, cp.goal, recent.slice(-300)].join(' ');
        const retrieved = buildRagContext(query, { settings, styles, chapters: novel.chapters, notes: novel.authorNotes }, cfg.rag);
        const context = renderContext(retrieved, recent);
        const text = await writeSegment(llm, { requirement: novel.requirement, context, chapterGoal: cp.title + '：' + cp.goal, nextBeat: cp.beats[si] ?? '' });
        assert.ok(text.length > 20, '段落过短');
        chapter.segments.push({ order: si + 1, text });
        saveNovel(novel);
      }
      // 规划指定章节审查
      if (cp.reviewAfter) {
        const report = await reviewChapter(llm, { text: chapter.segments.map((s) => s.text).join('\n\n'), goal: cp.goal, settingsSummary: settings.map((s) => s.name).join('；'), styleRules: styles.flatMap((s) => s.rules), scope: '本章' });
        novel.reviews.push({ id: 'rev_e2e_' + chOrder, kind: 'chapter', chapter: chOrder, passed: report.passed, score: report.score, issues: report.issues, strengths: report.strengths, suggestions: report.suggestions, ts: '2026-08-01T00:00:00.000Z' });
        saveNovel(novel);
      }
      // 每 N 章宏观一致性检查
      if (chOrder % cfg.macroCheckInterval === 0) {
        const allText = novel.chapters.map((c) => '第 ' + c.order + ' 章 ' + c.segments.map((s) => s.text).join('\n')).join('\n\n');
        const report = await macroCheck(llm, { text: allText, goal: novel.requirement, settingsSummary: settings.map((s) => s.name + '：' + s.facts.join('；')).join('\n'), styleRules: styles.flatMap((s) => s.rules), scope: '全书' });
        novel.reviews.push({ id: 'rev_e2e_macro_' + chOrder, kind: 'macro', chapter: chOrder, passed: report.passed, score: report.score, issues: report.issues, strengths: report.strengths, suggestions: report.suggestions, ts: '2026-08-01T00:00:00.000Z' });
        saveNovel(novel);
      }
    }
    const totalSegs = novel.chapters.reduce((a, c) => a + c.segments.length, 0);
    assert.ok(totalSegs >= 6, '总段落数过少: ' + totalSegs);
    assert.strictEqual(novel.reviews.length, 2, '审查记录数异常: ' + novel.reviews.length);
    ok('创作 Agent + 深度 RAG', totalSegs + ' 段 / 2 章');
    ok('审查 Agent', '章节审查 + 宏观检查共 2 份报告');
  } catch (e) { bad('写作/审查', e); }

  // ---- 4. 修改反馈 + 反馈学习 ----
  try {
    const target = novel.chapters[0].segments[0];
    recordFeedback({ id: 'fb_e2e_1', novelId: novel.id, chapter: 1, segment: 1, original: target.text, edited: target.text + '（作者修订：更短的句子。）', ts: '2026-08-01T00:00:00.000Z' });
    const records = listUnprocessedFeedback().filter((r) => r.id === 'fb_e2e_1');
    assert.strictEqual(records.length, 1);
    const cands = [];
    for (const r of records) cands.push(...analyzeFeedbackRuleBased(r.original, r.edited));
    const llmCands = await analyzeFeedbackWithLLM(llm, records);
    const merged = mergeCandidates(cands.concat(llmCands));
    const learned = applyPreferencesToStyle(service, null, merged, '验收反馈风格');
    markFeedbackProcessed(records.map((r) => r.id));
    assert.ok(learned.rules.length >= 1, '未提炼出规则');
    assert.strictEqual(listUnprocessedFeedback().filter((r) => r.id === 'fb_e2e_1').length, 0);
    ok('反馈学习', '提炼 ' + learned.rules.length + ' 条规则 → ' + learned.name);
  } catch (e) { bad('反馈学习', e); }

  // ---- 5. 落盘验收 ----
  try {
    const loaded = loadNovel(novel.id);
    assert.ok(loaded && loaded.chapters.length === 2, '续写加载异常');
    assert.strictEqual(loaded.reviewFocus, '设定一致性', '作品级审查重点未持久化');
    assert.strictEqual(loaded.reviewStrictness, 'strict', '作品级审查力度未持久化');
    const md = fs.readFileSync(path.join(novelDir(novel.id), 'manuscript.md'), 'utf8');
    assert.ok(md.includes('端到端验收作品'), '稿子缺标题');
    const revMd = fs.readFileSync(path.join(novelDir(novel.id), 'reviews.md'), 'utf8');
    assert.ok(revMd.includes('宏观一致性检查'), 'reviews.md 缺宏观记录');
    assert.ok(revMd.includes('章节审查'), 'reviews.md 缺章节审查');
    ok('持久化验收', 'session.json + manuscript.md + plan.md + reviews.md 齐全');
  } catch (e) { bad('持久化', e); }

  // ---- 6. 清理 ----
  fs.rmSync(novelDir(novel.id), { recursive: true, force: true });
  for (const s of service.listStyles()) if (s.name.includes('验收')) service.removeStyle(s.id);
  for (const s of service.listSettings()) if (s.name.includes('北境') || s.name.includes('阿翎')) service.removeSetting(s.id);
  const fb1 = path.join(ws, 'feedback', 'fb_e2e_1.json');
  if (fs.existsSync(fb1)) fs.unlinkSync(fb1);

  console.log('\n端到端验收：' + results.length + ' 项通过');
  return results;
}

if (require.main === module) {
  main().catch((e) => { console.error('端到端验收异常：' + e); process.exitCode = 1; });
}

module.exports = { main };
