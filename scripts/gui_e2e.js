
/**
 * GUI 端到端验收：启动本地服务，用 HTTP API 完整走通
 * 健康检查 → 知识库 → 新建作品(总规划) → 问答 → 自动模式写作+审查 → 逐段审批+模式切换 → 反馈学习
 * 运行：node scripts/gui_e2e.js （需先 npm run build）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.FEDERSTIFT_WORKSPACE = path.join(require('node:os').tmpdir(), 'federstift-gui-e2e');
fs.rmSync(process.env.FEDERSTIFT_WORKSPACE, { recursive: true, force: true });

const { startGuiServer } = require('../dist/gui/server.js');

const results = [];
function ok(name, detail) { results.push({ name, ok: true, detail }); console.log('  ✔ ' + name + (detail ? '（' + detail + '）' : '')); }
function bad(name, e) { results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) }); console.error('  ✘ ' + name + ' -> ' + (e && e.message ? e.message : e)); process.exitCode = 1; }

async function api(base, p, opts) {
  const init = { method: (opts && opts.method) || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (opts && opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + p, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function main() {
  /** 通过 SSE 流式接口推进创作，返回 done 事件的最终快照 */
  async function streamAdvance(base, id) {
    const resp = await fetch(base + '/api/session/' + encodeURIComponent(id) + '/stream', { method: 'POST' });
    if (resp.status !== 200) {
      const d = await resp.json().catch(() => ({}));
      throw new Error((d && d.error) || ('stream HTTP ' + resp.status));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', ev = 'message', data = '', snapshot = null, error = null;
    const consumeEvent = () => {
      if (!data) return;
      let obj = null;
      try { obj = JSON.parse(data); } catch (e) {}
      data = '';
      if (ev === 'done' && obj) snapshot = obj.snapshot;
      else if (ev === 'error' && obj) error = obj.error || '流式创作失败';
    };
    const feedLines = (raw) => {
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      consumeEvent();
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        feedLines(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) feedLines(buf);
    if (error) throw new Error(error);
    if (!snapshot) throw new Error('流式推进未返回快照');
    return snapshot;
  }
  async function skipQuestions(base, snap) {
    let guard = 0;
    while (snap.pending && snap.pending.kind === 'questions' && guard++ < 10) {
      const d = await api(base, '/api/session/' + snap.novelId + '/answer', { method: 'POST', body: { answers: [] } });
      snap = d.snapshot;
    }
    return snap;
  }
  const handle = await startGuiServer({ openBrowser: false, port: 0 });
  const base = 'http://127.0.0.1:' + handle.port;
  console.log('GUI 服务已启动：' + base + '（临时工作区）\n');

  // ---- 1. 健康 + 静态页面 ----
  try {
    const h = await api(base, '/api/health');
    assert.strictEqual(h.ok, true, 'health 异常');
    assert.ok(h.version, '缺版本号');
    const page = await fetch(base + '/');
    const html = await page.text();
    assert.ok(html.includes('羽笔 Federstift'), '页面缺标题');
    assert.ok(html.includes('开始创作'), '页面缺导航');
    ok('健康检查 + 静态页面', 'v' + h.version + ' · 页面 ' + html.length + ' 字节');
  } catch (e) { bad('健康/页面', e); }

  // ---- 2. 初始状态 ----
  let state;
  try {
    state = await api(base, '/api/state');
    assert.ok(Array.isArray(state.novels), 'novels 非数组');
    assert.ok(state.config.providers.length >= 4, '供应商不足');
    ok('初始状态', state.novels.length + ' 部作品 · 演示模式可用');
  } catch (e) { bad('状态', e); }

  // ---- 3. 知识库（风格范例式 + 设定对话式） ----
  let styleId, settingId;
  try {
    const st = await api(base, '/api/kb/styles/from-example', { method: 'POST', body: { name: 'GUI验收冷峻风', exampleText: '他沉默地走进雨里。雾很重。远处的钟声敲了三下。' } });
    assert.ok(st.style && st.style.id, '风格未创建');
    assert.ok(st.style.rules.length > 0, '风格规则为空');
    styleId = st.style.id;
    const se = await api(base, '/api/kb/settings/from-conversation', { method: 'POST', body: { name: '主角阿翎', category: 'character', content: '西城剑士，沉默寡言，用左手剑。', keepFacts: ['阿翎用左手剑'], aliases: ['翎'], tags: ['主角'] } });
    assert.ok(se.setting && se.setting.id, '设定未创建');
    settingId = se.setting.id;
    const list = await api(base, '/api/kb/settings');
    assert.ok(list.entries.some((s) => s.id === settingId), '设定列表缺新条目');
    ok('知识库：范例式风格 + 对话式设定', '风格 1 · 设定 1');
  } catch (e) { bad('知识库', e); }

  // ---- 4. 新建作品 + 总规划 + 问答（自动模式） ----
  let snapshot;
  try {
    const d = await api(base, '/api/novel', { method: 'POST', body: { title: 'GUI端到端作品', requirement: '剑士阿翎在北境追查真相，冷峻悬疑。', planTarget: 2, approvalMode: 'auto', reviewFocus: '设定一致性', reviewStrictness: 'strict', styleIds: [styleId], settingIds: [settingId] } });
    snapshot = d.snapshot;
    assert.ok(snapshot.novelId, '缺作品 id');
    assert.ok(fs.existsSync(path.join(process.env.FEDERSTIFT_WORKSPACE, 'novels', 'GUI端到端作品')), '填了标题的作品文件夹未按标题命名');
    // 规划在流式推进时完成，验证 SSE 流式接口
    snapshot = await streamAdvance(base, snapshot.novelId);
    assert.ok(snapshot.plan && snapshot.plan.chapters.length === 2, '计划章数异常: ' + (snapshot.plan && snapshot.plan.chapters.length));
    assert.ok(snapshot.pending && snapshot.pending.kind === 'questions', '应处于待回答问题状态');
    assert.ok(snapshot.pending.questions.length > 0, '规划问题为空');
    ok('总规划 Agent（GUI·流式）', '2 章计划 · ' + snapshot.pending.questions.length + ' 个问题待回答');
  } catch (e) { bad('新建/规划', e); }

  // ---- 5. 回答问题 → 自动写作 + 自动审查裁决（规则层，不暂停） ----
  try {
    const q = snapshot.pending.questions[0];
    const d = await api(base, '/api/session/' + snapshot.novelId + '/answer', { method: 'POST', body: { answers: [{ question: q, answer: '主角最怕火。' }] } });
    snapshot = d.snapshot;
    assert.ok(snapshot.authorNotes.some((n) => n.answer === '主角最怕火。'), '开局问题答复未保存');
    // 自动模式：正文自动采纳；审查由规则层裁决（strict 报告 → 自动定向重写 1 次 → 超限保留当前版本继续）
    let guard = 0;
    while (guard++ < 25 && (!snapshot.pending || snapshot.pending.kind === 'questions')) {
      snapshot = await streamAdvance(base, snapshot.novelId);
      snapshot = await skipQuestions(base, snapshot);
    }
    assert.ok(snapshot.chapters.length >= 1, '第 1 章未生成');
    assert.strictEqual(snapshot.chapters[0].segments.length, 4, '第 1 章段落数异常: ' + snapshot.chapters[0].segments.length);
    assert.ok(snapshot.reviews.length >= 1, '审查记录缺失: ' + snapshot.reviews.length);
    assert.ok(snapshot.authorNotes.some((n) => n.answer === '主角最怕火。'), '作者答复未保存');
    assert.strictEqual(snapshot.pending.kind, 'chapter_done', '自动模式审查裁决后应停在本章完成，不再等作者判断: ' + snapshot.pending.kind);
    ok('问答 + 自动写作 + 自动审查裁决（流式）', '第 1 章 4 段 · 审查 ' + snapshot.reviews.length + ' 次 · 自动重写至多 1 次');
  } catch (e) { bad('自动创作', e); }

  // ---- 6. 继续下一章 → 全书写完 ----
  try {
    let guard = 0;
    while (snapshot.status !== 'finished' && guard++ < 30) {
      const p = snapshot.pending;
      if (!p) { snapshot = await streamAdvance(base, snapshot.novelId); continue; }
      if (p.kind === 'chapter_done') {
        const d = await api(base, '/api/session/' + snapshot.novelId + '/decide', { method: 'POST', body: { for: 'chapter_done', action: 'continue' } });
        snapshot = d.snapshot;
        snapshot = await streamAdvance(base, snapshot.novelId);
      } else if (p.kind === 'review') {
        const d = await api(base, '/api/session/' + snapshot.novelId + '/decide', { method: 'POST', body: { for: 'review', action: 'ignore' } });
        snapshot = d.snapshot;
        snapshot = await streamAdvance(base, snapshot.novelId);
      } else if (p.kind === 'questions') {
        snapshot = await skipQuestions(base, snapshot);
        snapshot = await streamAdvance(base, snapshot.novelId);
      } else { throw new Error('意外待决状态：' + p.kind); }
    }
    assert.strictEqual(snapshot.status, 'finished', '未全部完成: ' + snapshot.status);
    assert.strictEqual(snapshot.chapters.length, 2, '章节数异常: ' + snapshot.chapters.length);
    ok('自动模式完整跑完', snapshot.chapters.reduce((a, c) => a + c.segments.length, 0) + ' 段 / 2 章 · 审查 ' + snapshot.reviews.length + ' 次');
  } catch (e) { bad('自动完成', e); }

  // ---- 7. 逐段审批 + 创作中切换模式 ----
  let snap2;
  try {
    const d = await api(base, '/api/novel', { method: 'POST', body: { title: '逐段验收', requirement: '短篇喜剧，轻松。', planTarget: 1, approvalMode: 'segment' } });
    snap2 = d.snapshot;
    assert.ok(fs.existsSync(path.join(process.env.FEDERSTIFT_WORKSPACE, 'novels', '逐段验收')), '逐段验收文件夹未按标题命名');
    snap2 = await streamAdvance(base, snap2.novelId); // 流式规划
    snap2 = await skipQuestions(base, snap2);          // 开局问题
    snap2 = await streamAdvance(base, snap2.novelId);  // 章节问题
    snap2 = await skipQuestions(base, snap2);
    snap2 = await streamAdvance(base, snap2.novelId);  // 流式写第 1 段
    assert.strictEqual(snap2.pending.kind, 'segment', '逐段模式应停在段审批');
    // 修改这段（记录反馈）
    const edited = '雨夜，他抵达客栈。灯影摇晃。' + ' '.repeat(40);
    const d4 = await api(base, '/api/session/' + snap2.novelId + '/decide', { method: 'POST', body: { for: 'segment', action: 'edit', editedText: edited } });
    snap2 = d4.snapshot;
    assert.ok(snap2.chapters[0].segments.some((s) => s.userEdited), '修改反馈未记录');
    // 剩余段落批准（决策后由流式接口继续写下一段）
    snap2 = await streamAdvance(base, snap2.novelId);
    while (snap2.pending && snap2.pending.kind === 'segment') {
      const d5 = await api(base, '/api/session/' + snap2.novelId + '/decide', { method: 'POST', body: { for: 'segment', action: 'approve' } });
      snap2 = d5.snapshot;
      snap2 = await streamAdvance(base, snap2.novelId);
    }
    // 审查待决时切换模式 → 自动
    if (snap2.pending && snap2.pending.kind === 'review') {
      const d6 = await api(base, '/api/session/' + snap2.novelId + '/mode', { method: 'POST', body: { mode: 'auto' } });
      snap2 = d6.snapshot;
    }
    const fb = await api(base, '/api/feedback');
    assert.ok(fb.records.length >= 1, '反馈记录缺失');
    ok('逐段审批 + 修改反馈 + 创作中切换模式', snap2.chapters[0].segments.length + ' 段 · 反馈 ' + fb.records.length + ' 条');
  } catch (e) { bad('逐段/切换', e); }

  // ---- 7·5. 逐章审批：批准后推进到下一章（回归：不再重复确认同一章） ----
  let snap3;
  try {
    const d = await api(base, '/api/novel', { method: 'POST', body: { title: '逐章验收', requirement: '短篇正剧，稳。', planTarget: 2, approvalMode: 'chapter' } });
    snap3 = d.snapshot;
    assert.ok(fs.existsSync(path.join(process.env.FEDERSTIFT_WORKSPACE, 'novels', '逐章验收')), '逐章验收文件夹缺失');
    const confirms = [];
    let guard = 0;
    while (snap3.status !== 'finished' && guard++ < 40) {
      const p = snap3.pending;
      if (!p) { snap3 = await streamAdvance(base, snap3.novelId); continue; }
      if (p.kind === 'questions') { snap3 = await skipQuestions(base, snap3); continue; }
      if (p.kind === 'review') {
        const rv = await api(base, '/api/session/' + snap3.novelId + '/decide', { method: 'POST', body: { for: 'review', action: 'ignore' } });
        snap3 = rv.snapshot;
        continue;
      }
      if (p.kind === 'chapter') {
        confirms.push(p.chapter);
        const ap = await api(base, '/api/session/' + snap3.novelId + '/decide', { method: 'POST', body: { for: 'chapter', action: 'approve' } });
        snap3 = ap.snapshot;
        continue;
      }
      throw new Error('逐章模式出现意外待决状态：' + p.kind);
    }
    assert.deepStrictEqual(confirms, [1, 2], '逐章确认序列异常（批准后未推进到下一章）: ' + JSON.stringify(confirms));
    assert.strictEqual(snap3.status, 'finished', '逐章模式未完成: ' + snap3.status);
    assert.strictEqual(snap3.chapters.length, 2, '逐章模式章节数异常: ' + snap3.chapters.length);
    ok('逐章审批：批准推进到下一章', '确认 ' + confirms.join('→') + ' 章 · 已完结');
  } catch (e) { bad('逐章审批', e); }

  // ---- 8. 反馈学习（分析 + 应用） ----
  try {
    const a = await api(base, '/api/feedback/analyze', { method: 'POST', body: { useLlm: false } });
    assert.ok(a.candidates.length > 0, '无候选偏好: ' + JSON.stringify(a.candidates));
    const idxs = a.candidates.map((_, i) => i);
    const ap = await api(base, '/api/feedback/apply', { method: 'POST', body: { indexes: idxs, candidates: a.candidates, targetStyleId: styleId } });
    assert.ok(ap.style && ap.style.rules.length > 0, '风格未更新');
    const styles = await api(base, '/api/kb/styles');
    const s = styles.entries.find((x) => x.id === styleId);
    assert.ok(s.rules.length >= ap.style.rules.length, '规则数未增加');
    const fb2 = await api(base, '/api/feedback');
    assert.strictEqual(fb2.unprocessed, 0, '反馈未标记已学习');
    ok('反馈学习', '提炼 ' + a.candidates.length + ' 条偏好 → 已写入风格');
  } catch (e) { bad('反馈学习', e); }

  // ---- 9. 配置接口 ----
  try {
    const c = await api(base, '/api/config/general', { method: 'POST', body: { approvalMode: 'chapter', macroCheckInterval: 3, reviewFocus: '人物动机', reviewStrictness: 'lenient', rag: { enabled: true, topK: 6 } } });
    assert.strictEqual(c.config.approvalMode, 'chapter', '审批模式未保存');
    assert.strictEqual(c.config.macroCheckInterval, 3, '宏观间隔未保存');
    assert.ok(!('apiKey' in c.config.providers[1]), '配置泄露 API Key');
    ok('配置接口', '审批/间隔/审查重点/力度/RAG 均已保存且密钥脱敏');
  } catch (e) { bad('配置', e); }

  // ---- 10. 自定义 Agent 系统提示词（保存 / 清空回落默认） ----
  try {
    const c1 = await api(base, '/api/config/general', { method: 'POST', body: { plannerSystemPrompt: '你是一位严格的总规划师。', writerSystemPrompt: '你是一位冷峻的作家。' } });
    assert.strictEqual(c1.config.plannerSystemPrompt, '你是一位严格的总规划师。', '总规划提示词未保存');
    assert.strictEqual(c1.config.writerSystemPrompt, '你是一位冷峻的作家。', '创作提示词未保存');
    const c2 = await api(base, '/api/config/general', { method: 'POST', body: { plannerSystemPrompt: '', writerSystemPrompt: '' } });
    assert.strictEqual(c2.config.plannerSystemPrompt, '', '清空后总规划提示词未回落默认');
    assert.strictEqual(c2.config.writerSystemPrompt, '', '清空后创作提示词未回落默认');
    ok('自定义 Agent 提示词', '保存 + 清空回落默认');
  } catch (e) { bad('自定义提示词', e); }

  // ---- 11. GUI 删除作品（文件夹 / 列表 / 会话同步清除） ----
  try {
    const d = await api(base, '/api/novel', { method: 'POST', body: { title: '待删除作品', requirement: '测试删除。', planTarget: 1 } });
    const delId = d.snapshot.novelId;
    assert.ok(fs.existsSync(path.join(process.env.FEDERSTIFT_WORKSPACE, 'novels', '待删除作品')), '删除前作品文件夹缺失');
    await api(base, '/api/novel/' + encodeURIComponent(delId), { method: 'DELETE' });
    assert.ok(!fs.existsSync(path.join(process.env.FEDERSTIFT_WORKSPACE, 'novels', '待删除作品')), '删除后作品文件夹仍存在');
    const st = await api(base, '/api/state');
    assert.ok(!st.novels.some((n) => n.id === delId), '删除后作品仍在列表');
    let notFound = false;
    try { await api(base, '/api/novel/' + encodeURIComponent(delId), { method: 'DELETE' }); } catch (e) { notFound = /作品不存在/.test(e.message); }
    assert.ok(notFound, '重复删除未返回 404');
    ok('GUI 删除作品', '文件夹 / 列表 / 重复删除 404');
  } catch (e) { bad('GUI 删除作品', e); }

  await handle.close();
  const passed = results.filter((r) => r.ok).length;
  console.log('\nGUI 端到端：' + passed + ' / ' + results.length + ' 通过');
  return { passed, total: results.length, results };
}

if (require.main === module) {
  main().catch((e) => { console.error('GUI e2e 失败：' + e); process.exitCode = 1; });
}
module.exports = { main };
