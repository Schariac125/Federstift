/**
 * 冒烟测试：验证核心模块（配置/知识库/提取/RAG/作品持久化/演示 LLM）
 * 运行：node scripts/smoke.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 冒烟测试使用独立临时工作区，绝不触碰用户的真实数据（FEDERSTIFT_WORKSPACE 由 storage.workspaceDir 读取）
process.env.FEDERSTIFT_WORKSPACE = path.join(require('node:os').tmpdir(), 'federstift-smoke');
fs.rmSync(process.env.FEDERSTIFT_WORKSPACE, { recursive: true, force: true });

const { loadConfig, saveConfig, setApprovalMode, setProviderApiKey, getActiveProvider, defaultConfig } = require('../dist/core/config.js');
const { createKbService, newStyle, newSetting, newTemplate } = require('../dist/kb/service.js');
const { extractSettings } = require('../dist/kb/extract.js');
const { bm25Top } = require('../dist/rag/bm25.js');
const { buildRagContext, renderContext, emptyRetrieval } = require('../dist/rag/context.js');
const { chunkText } = require('../dist/rag/indexer.js');
const { normalizePlan } = require('../dist/agents/planner.js');
const { normalizeReview, reviewChapter, macroCheck, buildReviewUser } = require('../dist/agents/reviewer.js');
const { analyzeFeedbackRuleBased, mergeCandidates, applyPreferencesToStyle, listUnprocessedFeedback, markFeedbackProcessed, saveFeedbackRecord, analyzeFeedbackWithLLM } = require('../dist/learning/feedback.js');
const { newNovel, saveNovel, loadNovel, listNovels, novelDir, manuscriptPath, deleteNovel } = require('../dist/pipeline/novel.js');
const { DemoLLM, extractJson } = require('../dist/core/llm.js');
const { workspaceDir } = require('../dist/core/storage.js');

let passed = 0;
const results = [];
function ok(name) { passed++; results.push('✔ ' + name); console.log('  ✔ ' + name); }
function fail(name, e) { results.push('✘ ' + name + ' -> ' + (e && e.message ? e.message : e)); console.error('  ✘ ' + name + ' -> ' + (e && e.message ? e.message : e)); process.exitCode = 1; }

async function main() {
  const root = path.resolve(__dirname, '..');
  const ws = workspaceDir();
  console.log('工作区：' + ws);

  // ---- 1. 配置 ----
  try {
    const cfg = loadConfig();
    assert.ok(cfg.providers.length >= 4, '内置供应商不足');
    assert.ok(getActiveProvider(cfg), '无激活供应商');
    setApprovalMode(cfg, 'segment');
    assert.strictEqual(loadConfig().approvalMode, 'segment', '审批模式未持久化');
    setApprovalMode(cfg, 'auto');
    ok('配置：默认值/供应商/审批模式');
  } catch (e) { fail('配置', e); }

  // ---- 2. 知识库 ----
  try {
    const kb = createKbService();
    const style = newStyle({ name: '测试冷峻风', rules: ['句子短促', '第三人称'], exampleText: '示例。', source: 'example' });
    const setting = newSetting({ name: '主角阿翎', category: 'character', content: '阿翎是西城剑士，沉默寡言。', facts: ['阿翎用左手剑'], aliases: ['阿翎', '翎'], source: 'conversation' });
    const tpl = newTemplate({ name: '测试模板', purpose: '测试', prompt: '为 {人物} 写小传' });
    kb.saveStyle(style); kb.saveSetting(setting); kb.saveTemplate(tpl);
    assert.strictEqual(kb.listStyles().length, 1);
    assert.strictEqual(kb.listSettings().length, 1);
    assert.strictEqual(kb.listTemplates().length, 1);
    const hits = kb.search('settings', '阿翎');
    assert.ok(hits.length >= 1, '搜索未命中');
    kb.removeSetting(setting.id);
    assert.strictEqual(kb.listSettings().length, 0, '删除后仍可见');
    // 清理
    kb.removeStyle(style.id); kb.removeTemplate(tpl.id);
    ok('知识库：增/查/搜/删');
  } catch (e) { fail('知识库', e); }

  // ---- 3. 自动提取设定 ----
  try {
    const text = '林默是一名退役军医，性格冷静。他来自北境霜城。霜城是帝国边境的冰封要塞。公元 1173 年，北境战争爆发。他随身带着一柄断剑。';
    const cands = extractSettings(text);
    assert.ok(cands.length >= 3, '候选过少: ' + cands.length);
    ok('自动提取：' + cands.length + ' 条候选');
  } catch (e) { fail('自动提取', e); }

  // ---- 4. 总规划 Agent ----
  try {
    const plan = normalizePlan({
      premise: '测试',
      strategy: '悬念开场',
      styleDirectives: ['句子短促'],
      questions: ['主角想要什么？'],
      reviewSchedule: '每章自查',
      chapters: [{ order: 1, title: '开场', goal: '引入主角', beats: ['雨夜', '发现'], questions: [], reviewAfter: true, segments: 99 }]
    }, 3);
    assert.strictEqual(plan.chapters.length, 3, '章数未补齐');
    assert.strictEqual(plan.chapters[0].segments, 10, 'segments 未钳制到上限');
    const bad = normalizePlan(null, 2);
    assert.strictEqual(bad.chapters.length, 2, '空计划未补默认');
    ok('规划 Agent：normalizePlan 补齐/钳制');
  } catch (e) { fail('规划 Agent', e); }

  // ---- 4.5 审查 Agent ----
  try {
    const norm = normalizeReview({
      passed: false,
      score: { overall: 300, plot: -5, settingConsistency: 88 },
      issues: [
        { severity: 'info', dimension: 'style', description: '小问题', suggestion: '' },
        { severity: 'error', dimension: 'logic', description: '逻辑断裂', suggestion: '补一句过渡' },
        { severity: 'unknown', dimension: 'bad', description: '非法项' }
      ],
      strengths: ['人物立体'],
      suggestions: ['精简第三段']
    });
    assert.strictEqual(norm.score.overall, 100, 'overall 未钳制到 100');
    assert.strictEqual(norm.score.plot, 0, 'plot 负分未钳制到 0');
    assert.strictEqual(norm.score.settingConsistency, 88, 'settingConsistency 异常');
    assert.strictEqual(norm.issues.length, 3, 'issue 数量异常');
    assert.strictEqual(norm.issues[0].severity, 'error', 'error 未排到最前');
    assert.strictEqual(norm.issues[2].severity, 'info', '非法 severity 未归一');
    assert.strictEqual(norm.issues[2].dimension, 'other', '非法 dimension 未归一');
    assert.strictEqual(norm.passed, false, 'passed 异常');
    ok('审查 Agent：normalizeReview 钳制/过滤/排序');
  } catch (e) { fail('审查 Agent normalize', e); }

  try {
    const demoR = new DemoLLM();
    const rep = await reviewChapter(demoR, { text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章' });
    assert.ok(rep.score && typeof rep.score.overall === 'number', '审查报告缺分数');
    assert.ok(Array.isArray(rep.issues) && rep.issues.length > 0, '审查报告缺问题');
    const mrep = await macroCheck(demoR, { text: '全书', goal: 'g', settingsSummary: 's', styleRules: [], scope: '宏观' });
    assert.ok(mrep.suggestions, '宏观检查报告缺字段');
    ok('审查 Agent：章节审查 + 宏观检查（演示模式）');
  } catch (e) { fail('审查 Agent 调用', e); }

  try {
    const demoR2 = new DemoLLM();
    const userPrompt = buildReviewUser({ text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章', focus: '重点检查设定一致性与人物动机' });
    assert.ok(userPrompt.includes('【本次审查重点（请优先、加权检查以下内容）】重点检查设定一致性与人物动机'), 'focus 未注入审查提示');
    const plain = buildReviewUser({ text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章' });
    assert.ok(!plain.includes('本次审查重点'), '无 focus 时不应注入');
    const focusRep = await reviewChapter(demoR2, { text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章', focus: '设定一致性' });
    assert.ok(focusRep.issues.some((i) => i.dimension === 'settingConsistency'), '演示审查未按 focus 维度输出');
    ok('审查 Agent：自定义审查重点（注入 + 演示按维度响应）');
  } catch (e) { fail('审查 Agent focus', e); }

  try {
    const strictPrompt = buildReviewUser({ text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章', strictness: 'strict' });
    assert.ok(strictPrompt.includes('【审查力度】严格：从严审查'), 'strict 力度未注入');
    const demoR3 = new DemoLLM();
    const sRep = await reviewChapter(demoR3, { text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章', strictness: 'strict' });
    assert.ok(!sRep.passed && sRep.issues.some((i) => i.severity === 'error'), '严格模式应有 error 级问题且不通过');
    const lRep = await reviewChapter(demoR3, { text: '示例章节', goal: '目标', settingsSummary: '设定', styleRules: [], scope: '本章', strictness: 'lenient' });
    assert.ok(lRep.passed && lRep.issues.length === 0, '宽松模式应通过且无问题');
    ok('审查 Agent：自定义审查力度（注入 + 严格/宽松差异化）');
  } catch (e) { fail('审查 Agent 力度', e); }

  // ---- 4.8 反馈学习 ----
  try {
    const prefs = analyzeFeedbackRuleBased(
      '他缓缓地走过了那条长长的街道，心里非常平静，仿佛一切都与他无关。他望着远方的天际线，感觉所有的事情都已经结束了。',
      '他走过长街，心里很静。他望着远方，一切都结束了。'
    );
    const rules = prefs.map((p) => p.rule).join('|');
    assert.ok(rules.includes('句子更短促'), '未识别句子缩短: ' + rules);
    assert.ok(rules.includes('精简叙述'), '未识别精简: ' + rules);
    ok('反馈学习：规则式偏好提炼');
  } catch (e) { fail('反馈学习 规则式', e); }

  try {
    const merged = mergeCandidates([
      { rule: '句子更短促', reason: 'r1', confidence: 0.6, source: 'rule' },
      { rule: '句子更短促', reason: 'r2', confidence: 0.7, source: 'llm' },
      { rule: '低置信规则', reason: 'r3', confidence: 0.4, source: 'rule' }
    ]);
    assert.strictEqual(merged.length, 1, '合并/过滤异常: ' + JSON.stringify(merged));
    assert.ok(merged[0].confidence > 0.75, '置信度未叠加');
    assert.ok(merged[0].reason.includes('r1') && merged[0].reason.includes('r2'), '依据未合并');
    ok('反馈学习：合并去重与置信度叠加');
  } catch (e) { fail('反馈学习 合并', e); }

  try {
    const kbL = createKbService();
    const prefsL = [{ rule: '句子更短促', reason: 't', confidence: 0.8, source: 'rule' }];
    const created = applyPreferencesToStyle(kbL, null, prefsL, '反馈风格测试');
    assert.strictEqual(created.source, 'feedback', '新风格 source 异常');
    assert.strictEqual(created.rules.length, 1, '新风格规则数异常');
    const appended = applyPreferencesToStyle(kbL, created.id, prefsL);
    assert.strictEqual(appended.rules.length, 1, '重复规则未去重');
    kbL.removeStyle(created.id);
    ok('反馈学习：应用到风格库（新建/追加/去重）');
  } catch (e) { fail('反馈学习 应用', e); }

  try {
    const rec = { id: 'fb_test', novelId: 'n_test', chapter: 1, segment: 1, original: '原文。', edited: '修改。', ts: '2026-08-01T00:00:00.000Z' };
    saveFeedbackRecord(rec);
    assert.ok(listUnprocessedFeedback().some((r) => r.id === 'fb_test'), '未处理列表缺记录');
    markFeedbackProcessed(['fb_test']);
    assert.ok(!listUnprocessedFeedback().some((r) => r.id === 'fb_test'), '处理后仍出现在未处理列表');
    const llmP = await analyzeFeedbackWithLLM(new DemoLLM(), [rec]);
    assert.ok(Array.isArray(llmP) && llmP.length >= 1, 'LLM 偏好为空');
    fs.unlinkSync(path.join(ws, 'feedback', 'fb_test.json'));
    ok('反馈学习：已处理标记 + LLM 提炼（演示）');
  } catch (e) { fail('反馈学习 标记/LLM', e); }

  // ---- 5. RAG / BM25 / 深度检索 ----
  try {
    const docs = [
      { id: 'a', text: '阿翎是西城剑士 左手剑' },
      { id: 'b', text: '霜城 冰封要塞 帝国边境' },
      { id: 'c', text: '北境战争 公元1173' },
    ];
    const top = bm25Top('阿翎 剑士', docs, 2);
    assert.strictEqual(top[0].id, 'a', 'BM25 首选错误: ' + JSON.stringify(top));
    assert.strictEqual(top[0].text, docs[0].text, 'BM25 未带回 text');
    const chunks = chunkText('一二三四五六七八九十。'.repeat(20), 40, 8);
    assert.ok(chunks.length >= 3, 'chunkText 切块不足');
    const settings = [{ id: 's1', name: '阿翎', category: 'character', content: '西城剑士', facts: ['左手剑'], aliases: ['翎'], tags: [], source: 'conversation', createdAt: '', updatedAt: '' }];
    const styles = [{ id: 'y1', name: '冷峻风', description: '', rules: ['句子短促'], exampleText: '', tags: [], source: 'example', createdAt: '', updatedAt: '' }];
    const chapters = [{ order: 1, title: '开场', segments: [{ order: 1, text: '阿翎走进霜城城门。' }] }];
    const notes = [{ chapter: 0, question: '主角最害怕什么？', answer: '他怕火。', ts: '' }];
    const retr = buildRagContext('阿翎 剑士 怕火', { settings, styles, chapters, notes }, { topK: 2, chunkSize: 100, overlap: 10 });
    const ctx = renderContext(retr, '前文内容');
    assert.ok(ctx.includes('阿翎'), '上下文缺少设定');
    assert.ok(ctx.includes('怕火'), '上下文缺少作者答复');
    assert.ok(emptyRetrieval().chapterChunks.length === 0, 'emptyRetrieval 非空');
    ok('RAG：BM25 + 切块 + 设定/章节/答复多源检索');
  } catch (e) { fail('RAG', e); }

  // ---- 6. 作品持久化 ----
  try {
    const novel = newNovel({ title: '冒烟测试作品', requirement: '测试', approvalMode: 'auto', planTarget: 5 });
    assert.strictEqual(novel.id, '冒烟测试作品', '填了标题的作品文件夹应使用标题命名');
    novel.plan = normalizePlan(null, 2);
    novel.authorNotes = [{ chapter: 0, question: 'q', answer: 'a', ts: '' }];
    novel.chapters.push({ order: 1, title: '第 1 章', segments: [{ order: 1, text: '第一段正文。' }] });
    saveNovel(novel);
    const loaded = loadNovel(novel.id);
    assert.ok(loaded && loaded.chapters.length === 1, '会话未保存/加载');
    assert.ok(fs.existsSync(manuscriptPath(novel.id)), 'manuscript.md 缺失');
    const md = fs.readFileSync(manuscriptPath(novel.id), 'utf8');
    assert.ok(md.includes('第一段正文'), '稿子内容缺失');
    assert.ok(fs.existsSync(path.join(novelDir(novel.id), 'plan.md')), 'plan.md 缺失');
    novel.reviews.push({ id: 'rev_test', kind: 'chapter', chapter: 1, passed: true, score: { overall: 90, plot: 90, character: 90, settingConsistency: 90, style: 90, logic: 90, language: 90, pacing: 90 }, issues: [{ severity: 'info', dimension: 'style', description: '无', suggestion: '' }], strengths: [], suggestions: [], ts: '' });
    saveNovel(novel);
    assert.ok(fs.existsSync(path.join(novelDir(novel.id), 'reviews.md')), 'reviews.md 缺失');
    assert.ok(listNovels().some((n) => n.id === novel.id), '作品列表缺失');
    // 清理冒烟作品（同时验证 deleteNovel）
    assert.strictEqual(deleteNovel(novel.id), true, 'deleteNovel 未删除作品');
    assert.ok(!fs.existsSync(novelDir(novel.id)), 'deleteNovel 后文件夹仍存在');
    assert.ok(!listNovels().some((n) => n.id === novel.id), 'deleteNovel 后作品仍在列表');
    ok('作品：会话 + manuscript.md 双写 + deleteNovel');
  } catch (e) { fail('作品持久化', e); }

  // ---- 6. 演示 LLM 与 JSON 解析 ----
  try {
    const demo = new DemoLLM();
    const r = await demo.chat([{ role: 'user', content: '写一段关于剑士的故事' }]);
    assert.ok(r.text.length > 20, '演示正文过短');
    const plan = await demo.json('x', '请给出创作计划', {});
    assert.ok(plan && typeof plan === 'object', '演示 JSON 失败');
    const parsed = extractJson('```json\n{"a":1}\n```');
    assert.deepStrictEqual(parsed, { a: 1 }, '围栏 JSON 解析失败');
    ok('演示 LLM + JSON 修复解析');
  } catch (e) { fail('演示 LLM', e); }

  console.log('\n冒烟测试完成：' + passed + ' 项通过');
  return results;
}

if (require.main === module) {
  main().catch((e) => { console.error('冒烟测试异常：' + e); process.exitCode = 1; });
}

module.exports = { main };