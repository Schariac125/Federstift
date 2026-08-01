#!/usr/bin/env node
import { loadConfig, saveConfig, getActiveProvider, setProviderApiKey, setProviderModel, setCustomProvider, setApprovalMode, setReviewFocus, setReviewStrictness, PROVIDER_PRESETS } from '../core/config';
import type { AppConfig, ProviderConfig } from '../core/config';
import { createKbService } from '../kb/service';
import type { KbService } from '../kb/service';
import { newSetting, newStyle, newTemplate, describeSetting } from '../kb/service';
import { createSettingConversational } from '../kb/createSetting';
import { createStyleFromExample } from '../kb/createStyle';
import { extractSettings } from '../kb/extract';
import type { SettingEntry, SettingCategory, StyleEntry, TemplateEntry } from '../kb/types';
import { SETTING_CATEGORIES, categoryLabel } from '../kb/types';
import { startWriting, resumeMenu } from '../pipeline/write';
import { feedbackLearnFlow } from '../learning/flow';
import { ask, askChoice, askConfirm, askMultiline, divider, pressEnter, closeRl } from './interactive';
import { paint, ok, warn, err, info, heading, padCn } from './ui';
import { logger } from '../core/logger';
import { createLLM } from '../core/llm';
import { newId, nowIso, workspaceDir, appRoot } from '../core/storage';
import type { ApprovalMode } from '../core/types';
import { normalizeStrictness, STRICTNESS_LABEL, type ReviewStrictness } from '../agents/reviewer';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VERSION = '0.10.0';

const BANNER = () =>
  '\n' +
  paint.cyan('  ╭──────────────────────────────────────────────╮') + '\n' +
  paint.cyan('  │ ') + padCn(paint.bold('羽笔 Federstift') + paint.cyan(' · v' + VERSION), 45) + paint.cyan('│') + '\n' +
  paint.cyan('  │ ') + padCn(paint.dim('三 Agent · 深度 RAG · 人机协同审批'), 45) + paint.cyan('│') + '\n' +
  paint.cyan('  ╰──────────────────────────────────────────────╯') + '\n';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const service = createKbService();
  logger.init();
  const args = process.argv.slice(2);
  const cmd = args[0] ?? '';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log('federstift ' + VERSION);
    return;
  }
  if (cmd === 'gui') {
    await runGui();
    return;
  }
  if (cmd === 'doctor') {
    await runDoctor();
    return;
  }
  if (cmd === 'guide') {
    await showGuide();
    return;
  }
  if (cmd === 'config') {
    await configMenu(cfg);
    return;
  }
  if (cmd === 'kb') {
    await kbMenu(cfg, service);
    return;
  }
  if (cmd === 'demo') {
    await startWriting(cfg, service, { forceDemo: true });
    return;
  }
  if (cmd === 'resume') {
    const id = await resumeMenu();
    if (id) await startWriting(cfg, service, { resumeId: id });
    return;
  }
  if (cmd === 'start') {
    await startWriting(cfg, service, {});
    return;
  }

  // 首次运行引导
  if (!cfg.firstRunDone) {
    console.log(BANNER());
    await firstRunGuide(cfg);
  }
  await mainMenu(cfg, service);
}

async function runGui(): Promise<void> {
  const { startGuiServer } = await import('../gui/server');
  const cfg = loadConfig();
  if (!cfg.firstRunDone) {
    cfg.firstRunDone = true;
    saveConfig(cfg);
  }
  console.log(BANNER());
  console.log(paint.dim('正在启动图形界面（本地服务，数据仍在 workspace/）…\n'));
  try {
    const handle = await startGuiServer({ openBrowser: true });
    ok('GUI 已启动：' + paint.cyan(handle.url));
    console.log(paint.dim('浏览器没有自动打开？请手动访问上面的地址。窗口关闭或按 Ctrl+C 即退出。'));
  } catch (e) {
    err('GUI 启动失败：' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}

async function firstRunGuide(cfg: AppConfig): Promise<void> {
  divider('欢迎使用羽笔');
  console.log('这里没有复杂的概念，你只需要记住三条路：');
  console.log('  1. 什么都不配置 → 直接输入故事要求，马上开写（离线演示模式可先体验）；');
  console.log('  2. 配置模型密钥 → 用你自己的 API 正式创作（OpenAI / DeepSeek / 任意兼容接口）；');
  console.log('  3. 打理知识库 → 让 AI 记得你的设定、风格与提问模板（可选，随时可做）。');
  console.log('\n所有作品、设定、风格都存在本项目的 workspace 目录里，全部是普通文件，');
  console.log('你可以随时用任何编辑器打开、修改、备份。\n');
  const configNow = await askConfirm('现在配置模型吗？（跳过也能用演示模式体验）', false);
  if (configNow) await configMenu(cfg);
  cfg.firstRunDone = true;
  saveConfig(cfg);
  console.log('\n准备好了！');
}

async function mainMenu(cfg: AppConfig, service: KbService): Promise<void> {
  while (true) {
    console.clear();
    console.log(BANNER());
    const stats = service.stats();
    const provider = getActiveProvider(cfg);
    console.log(paint.dim('  当前模型：') + paint.cyan(provider.name) + (provider.apiKey ? paint.dim('（' + provider.model + '）') : paint.yellow('（未配置，演示模式）')));
    console.log(paint.dim('  知识库：风格 ') + String(stats.styles) + paint.dim(' · 设定 ') + String(stats.settings) + paint.dim(' · 模板 ') + String(stats.templates));
    console.log(paint.dim('  审批模式：') + paint.cyan(approvalLabel(cfg.approvalMode)) + '\n');
    const choice = await askChoice<string>('请选择', [
      { key: '1', label: '✍ 开始创作（输入要求即可）', value: 'write' },
      { key: '2', label: '📚 知识库管理（设定/风格/模板）', value: 'kb' },
      { key: '3', label: '⚙ 模型与设置', value: 'config' },
      { key: '4', label: '📖 使用说明', value: 'guide' },
      { key: '5', label: '📂 续写上次的作品', value: 'resume' },
      { key: '6', label: '🚪 退出', value: 'exit' }
    ]);
    if (choice === 'write') {
      await startWriting(cfg, service, {});
    } else if (choice === 'kb') {
      await kbMenu(cfg, service);
    } else if (choice === 'config') {
      await configMenu(cfg);
    } else if (choice === 'guide') {
      await showGuide();
    } else if (choice === 'resume') {
      const id = await resumeMenu();
      if (id) await startWriting(cfg, service, { resumeId: id });
      else await pressEnter();
    } else {
      break;
    }
  }
  closeRl();
  console.log('\n' + paint.green('再见，期待读到你的故事。'));
}

function approvalLabel(mode: ApprovalMode): string {
  if (mode === 'auto') return '自动（安静流淌）';
  if (mode === 'segment') return '逐段确认（细致掌控）';
  return '逐章确认（平衡模式）';
}

// ---------------- 知识库 ----------------

async function kbMenu(cfg: AppConfig, service: KbService): Promise<void> {
  while (true) {
    const stats = service.stats();
    console.clear();
    divider('知识库管理');
    console.log('风格库 ' + stats.styles + ' 条 · 设定库 ' + stats.settings + ' 条 · 模板库 ' + stats.templates + ' 条\n');
    const choice = await askChoice<string>('请选择', [
      { key: '1', label: '浏览全部（风格/设定/模板）', value: 'browse' },
      { key: '2', label: '对话式创建设定', value: 'addSetting' },
      { key: '3', label: '自动提取设定（粘贴一段文字）', value: 'extract' },
      { key: '4', label: '范例式创建风格（粘贴喜欢的段落）', value: 'addStyle' },
      { key: '5', label: '创建提问模板', value: 'addTemplate' },
      { key: '6', label: '搜索', value: 'search' },
      { key: '7', label: '删除条目', value: 'remove' },
      { key: '8', label: '反馈学习（从修改中提炼风格）', value: 'learn' },
      { key: '0', label: '返回', value: 'back' }
    ]);
    if (choice === 'back') return;
    if (choice === 'browse') await browseKb(service);
    if (choice === 'addSetting') await createSettingConversational(service);
    if (choice === 'extract') await extractFlow(service);
    if (choice === 'addStyle') {
      const llm = createLLM(getActiveProvider(cfg));
      await createStyleFromExample(service, llm);
    }
    if (choice === 'addTemplate') await createTemplateFlow(service);
    if (choice === 'search') await searchFlow(service);
    if (choice === 'remove') await removeFlow(service);
    if (choice === 'learn') await feedbackLearnFlow(cfg, service);
    await pressEnter();
  }
}

async function browseKb(service: KbService): Promise<void> {
  divider('风格库');
  const styles = service.listStyles();
  if (!styles.length) console.log('（空）');
  styles.forEach((s) => {
    console.log('  · ' + s.name + (s.description ? ' —— ' + s.description.slice(0, 30) : ''));
    s.rules.slice(0, 3).forEach((r) => console.log('      - ' + r));
  });
  divider('设定库');
  const settings = service.listSettings();
  if (!settings.length) console.log('（空）');
  settings.forEach((s) => console.log('  · ' + describeSetting(s)));
  divider('模板库');
  const templates = service.listTemplates();
  if (!templates.length) console.log('（空）');
  templates.forEach((t) => console.log('  · ' + t.name + ' —— ' + t.purpose.slice(0, 40)));
}

async function extractFlow(service: KbService): Promise<void> {
  divider('自动提取设定');
  console.log('把包含设定信息的一段文字粘贴进来（人物介绍、世界观描述、时间线等），');
  console.log('我会先自动识别，再由你确认保存。\n');
  const text = await askMultiline('粘贴文字');
  if (!text) { console.log('已取消。'); return; }
  const candidates = extractSettings(text);
  if (!candidates.length) {
    console.log('没有识别出明显的设定内容（规则提取比较保守）。');
    console.log('也可以改用「对话式创建设定」手动录入。');
    return;
  }
  console.log('\n识别到以下候选：');
  candidates.forEach((c, i) => {
    console.log('  ' + (i + 1) + '. [' + categoryLabel(c.category) + '] ' + c.name + '（置信度 ' + Math.round(c.confidence * 100) + '%）');
    console.log('      ' + c.content.slice(0, 50));
  });
  const sel = (await ask('要保存哪些？输入序号（逗号分隔），回车 = 全不保存')).trim();
  if (!sel) { console.log('已取消。'); return; }
  const keep = new Set<number>();
  sel.split(/[,，\s]+/).forEach((n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < candidates.length) keep.add(idx);
  });
  if (!keep.size) { console.log('没有选中，已取消。'); return; }
  let saved = 0;
  for (const idx of Array.from(keep).sort((a, b) => a - b)) {
    const c = candidates[idx];
    const name = (await ask('「' + c.name + '」的最终名字（回车保持不变）', c.name)).trim() || c.name;
    service.saveSetting(
      newSetting({ name, category: c.category, content: c.content, facts: c.facts, aliases: c.aliases, source: 'extracted' })
    );
    saved++;
  }
  console.log('✔ 已保存 ' + saved + ' 条设定。');
}

async function createTemplateFlow(service: KbService): Promise<void> {
  divider('创建提问模板');
  console.log('提问模板用于在创作中向 AI 提问时复用固定问法，可用 {变量} 占位。');
  const name = (await ask('模板名字（如：人物小传模板）')).trim();
  if (!name) { console.log('已取消。'); return; }
  const purpose = (await ask('这个模板用来做什么？')).trim();
  const prompt = await askMultiline('模板正文（如：请为 {人物名} 写一段 200 字的小传，突出 {特征}）');
  if (!prompt) { console.log('已取消。'); return; }
  const tagsRaw = (await ask('标签（逗号分隔）')).trim();
  service.saveTemplate(newTemplate({ name, purpose, prompt, tags: tagsRaw ? tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [] }));
  console.log('✔ 已保存提问模板。');
}

async function searchFlow(service: KbService): Promise<void> {
  const kw = (await ask('搜索关键词')).trim();
  if (!kw) return;
  console.log('\n—— 风格库命中 ——');
  service.search<StyleEntry>('styles', kw).forEach((s) => console.log('  · ' + s.name));
  console.log('—— 设定库命中 ——');
  service.search<SettingEntry>('settings', kw).forEach((s) => console.log('  · ' + describeSetting(s)));
  console.log('—— 模板库命中 ——');
  service.search<TemplateEntry>('templates', kw).forEach((t) => console.log('  · ' + t.name));
}

async function removeFlow(service: KbService): Promise<void> {
  const kind = await askChoice<string>('删除哪个库的条目？', [
    { key: '1', label: '风格库', value: 'styles' },
    { key: '2', label: '设定库', value: 'settings' },
    { key: '3', label: '模板库', value: 'templates' }
  ]);
  const items = kind === 'styles' ? service.listStyles() : kind === 'settings' ? service.listSettings() : service.listTemplates();
  if (!items.length) { console.log('（空）'); return; }
  items.forEach((it, i) => console.log('  ' + (i + 1) + '. ' + it.name));
  const sel = (await ask('输入要删除的序号（逗号分隔多个），回车 = 取消')).trim();
  if (!sel) return;
  const toRemove: string[] = [];
  sel.split(/[,，\s]+/).forEach((n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx >= 0 && idx < items.length) toRemove.push(items[idx].id);
  });
  toRemove.forEach((id) => {
    if (kind === 'styles') service.removeStyle(id);
    else if (kind === 'settings') service.removeSetting(id);
    else service.removeTemplate(id);
  });
  console.log('✔ 已删除 ' + toRemove.length + ' 条（原文件保留为 .deleted 留痕，可在 workspace 里找回）。');
}

// ---------------- 设置 ----------------

async function configMenu(cfg: AppConfig): Promise<void> {
  while (true) {
    const provider = getActiveProvider(cfg);
    console.clear();
    divider('模型与设置');
    console.log('当前使用：' + provider.name + ' / ' + provider.model + (provider.apiKey ? '' : '（未填密钥）') + '\n');
    const choice = await askChoice<string>('请选择', [
      { key: '1', label: '配置供应商（OpenAI / DeepSeek / 自定义）', value: 'provider' },
      { key: '2', label: '切换当前供应商', value: 'switch' },
      { key: '3', label: '审批模式：' + approvalLabel(cfg.approvalMode), value: 'approval' },
      { key: '4', label: '宏观一致性检查间隔（当前：每 ' + cfg.macroCheckInterval + ' 章）', value: 'macro' },
      { key: '5', label: 'RAG 检索设置（当前：' + (cfg.rag.enabled ? '开，topK=' + cfg.rag.topK : '关') + '）', value: 'rag' },
      { key: '6', label: '审查重点（当前：' + ((cfg.reviewFocus ?? '').trim() || '默认全维度') + '）', value: 'focus' },
      { key: '7', label: '审查力度（当前：' + STRICTNESS_LABEL[normalizeStrictness(cfg.reviewStrictness)].split('：')[0] + '）', value: 'strictness' },
      { key: '0', label: '返回', value: 'back' }
    ]);
    if (choice === 'back') return;
    if (choice === 'provider') await providerConfig(cfg);
    if (choice === 'switch') await switchProvider(cfg);
    if (choice === 'approval') {
      const mode = await askChoice<ApprovalMode>('审批模式', [
        { key: 'a', label: '自动：生成即采纳，安静流淌（推荐）', value: 'auto' },
        { key: 's', label: '逐段：每段确认/修改/重写', value: 'segment' },
        { key: 'c', label: '逐章：章末统一确认', value: 'chapter' }
      ], cfg.approvalMode);
      setApprovalMode(cfg, mode);
    }
    if (choice === 'macro') {
      const n = parseInt((await ask('每几章检查一次宏观一致性？', String(cfg.macroCheckInterval))).trim(), 10);
      if (!Number.isNaN(n) && n > 0) { cfg.macroCheckInterval = n; saveConfig(cfg); }
    }
    if (choice === 'rag') {
      cfg.rag.enabled = await askConfirm('启用 RAG 检索（设定一致性）？', cfg.rag.enabled);
      const topK = parseInt((await ask('每次检索注入几条设定？', String(cfg.rag.topK))).trim(), 10);
      if (!Number.isNaN(topK) && topK > 0) cfg.rag.topK = topK;
      saveConfig(cfg);
    }
    if (choice === 'focus') {
      const want = await askConfirm('设置审查重点？可让审查优先检查设定一致性、人物动机、文风节奏等', Boolean((cfg.reviewFocus ?? '').trim()));
      if (want) {
        const focus = (await ask('审查重点（直接回车 = 清空，恢复默认全维度审查）')).trim();
        setReviewFocus(cfg, focus);
      } else {
        setReviewFocus(cfg, '');
      }
    }
    if (choice === 'strictness') {
      const s = await askChoice<ReviewStrictness>('默认审查力度', [
        { key: 's', label: STRICTNESS_LABEL.strict, value: 'strict' },
        { key: 'b', label: STRICTNESS_LABEL.standard, value: 'standard' },
        { key: 'l', label: STRICTNESS_LABEL.lenient, value: 'lenient' }
      ], normalizeStrictness(cfg.reviewStrictness));
      setReviewStrictness(cfg, s);
    }
    await pressEnter();
  }
}

async function providerConfig(cfg: AppConfig): Promise<void> {
  const choice = await askChoice<string>('选择供应商', PROVIDER_PRESETS.map((p) => ({ key: p.id, label: p.name, value: p.id })));
  if (choice === 'demo') {
    console.log('演示模式无需配置，回车返回。');
    return;
  }
  if (choice === 'custom') {
    const baseUrl = (await ask('接口地址（如 https://your-api.example.com/v1）')).trim();
    const apiKey = (await ask('API Key')).trim();
    const model = (await ask('模型名')).trim();
    if (baseUrl && apiKey && model) setCustomProvider(cfg, baseUrl, apiKey, model);
    else console.log('信息不完整，未保存。');
    return;
  }
  const apiKey = (await ask('API Key（输入后保存在本地 workspace/config.json）')).trim();
  if (apiKey) {
    setProviderApiKey(cfg, choice, apiKey);
    const model = (await ask('模型名', cfg.providers.find((p) => p.id === choice)?.model ?? '')).trim();
    if (model) setProviderModel(cfg, choice, model);
    console.log('✔ 已保存并切换。');
  } else {
    console.log('未输入，已取消。');
  }
}

async function switchProvider(cfg: AppConfig): Promise<void> {
  const choice = await askChoice<string>('切换到哪个供应商？', cfg.providers.map((p) => ({ key: p.id, label: p.name + (p.apiKey ? ' ✔' : '（未填密钥）'), value: p.id })));
  cfg.activeProviderId = choice;
  saveConfig(cfg);
  console.log('已切换：' + choice);
}

// ---------------- 说明 ----------------


// ---------------- 自检 ----------------

async function runDoctor(): Promise<void> {
  divider('羽笔环境自检 · v' + VERSION);
  const issues: string[] = [];
  const warns: string[] = [];

  // 1. Node 版本
  const nodeVer = process.versions?.node ?? '';
  const major = parseInt(nodeVer.split('.')[0] ?? '0', 10);
  if (major >= 18) {
    ok('Node.js ' + nodeVer + '（>= 18）');
  } else {
    err('Node.js ' + (nodeVer || '未知') + '，需要 18 或更高版本');
    issues.push('Node 版本过低');
  }

  // 2. 工作区可写
  try {
    const probe = path.join(workspaceDir(), '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    ok('工作区可写：' + workspaceDir());
  } catch (e) {
    err('工作区不可写：' + (e instanceof Error ? e.message : String(e)));
    issues.push('工作区不可写');
  }

  // 3. 配置与供应商
  const cfg = loadConfig();
  const provider = getActiveProvider(cfg);
  if (provider.apiKey) {
    ok('当前供应商：' + provider.name + ' / ' + provider.model);
  } else {
    info('当前供应商：' + provider.name + '（未配置密钥，将使用演示模式）');
    warns.push('尚未配置模型密钥：零配置可直接体验演示，正式创作请在「模型与设置」填入 API Key');
  }

  // 4. 知识库
  const stats = createKbService().stats();
  ok('知识库：风格 ' + stats.styles + ' · 设定 ' + stats.settings + ' · 模板 ' + stats.templates);

  // 5. 编译产物
  const distEntry = path.join(appRoot(), 'dist', 'cli', 'index.js');
  if (fs.existsSync(distEntry)) ok('编译产物完整');
  else { err('编译产物缺失（请重新运行 build）'); issues.push('编译产物缺失'); }

  console.log('\n' + paint.dim('审批模式：') + paint.cyan(approvalLabel(cfg.approvalMode)) + paint.dim(' · 宏观检查：每 ') + String(cfg.macroCheckInterval) + paint.dim(' 章 · RAG：') + (cfg.rag.enabled ? paint.green('开') : paint.yellow('关')));
  if (warns.length) {
    heading('提示');
    for (const w of warns) warn(w);
  }
  if (issues.length) {
    heading('发现 ' + issues.length + ' 个问题，请修复后重试');
    for (const it of issues) err(it);
    process.exitCode = 1;
  } else {
    console.log('\n' + paint.green('✔ 环境正常，可以开始创作。'));
  }
}

async function showGuide(): Promise<void> {
  divider('使用说明（简版）');
  console.log(HELP);
  console.log('\n完整说明书：docs/使用说明书.md');
  await pressEnter();
}

const HELP = `
羽笔 Federstift v${VERSION}

推荐入口
  双击 run.bat 默认打开图形界面（GUI），或执行：node dist/cli/index.js gui
  全部功能（创作/知识库/设置/反馈学习）都在图形界面里完成，无需记命令。

开始创作
  图形界面「开始创作」→ 输入故事要求 → 总规划 Agent 制定策略并提问（可跳过）→ 开写。
  什么都没配置也能用「离线演示模式」体验完整流程。

知识库（可选，但强烈建议用起来）
  · 设定库：对话式创建，或粘贴文字自动提取。让 AI 记得人物/世界观/时间线。
  · 风格库：粘贴一段你喜欢的范例，提炼成可复用写作规则。
  · 模板库：保存常用的提问模板。

模型与设置
  配置 OpenAI / DeepSeek / 任意 OpenAI 兼容供应商的 API Key 后正式创作；
  审批模式：自动（安静流淌）/ 逐段（细致掌控）/ 逐章（平衡），创作中可随时切换。
  审查：规划指定的章节与每 N 章宏观一致性检查自动触发，报告存 reviews.md。
  审查力度：严格 / 标准 / 宽松，全局默认 + 作品级 + 单次审查后调整。
  审查重点：可自定义方向（如设定一致性、人物动机），全局默认 + 作品级覆盖。

命令行入口（可选）
  gui       打开图形界面（推荐，双击 run.bat 即此入口）
  start     命令行创作（引导式问答）
  resume    续写作品
  config    模型与设置
  kb        知识库管理
  doctor    环境自检

数据都在本地
  作品：workspace/novels/<作品>/manuscript.md（可用任何编辑器打开）
  知识库：workspace/styles、workspace/settings、workspace/templates
  你的修改反馈：workspace/feedback（用于后续风格学习）
`;

main().catch((e) => {
  console.error('发生错误：' + (e instanceof Error ? e.message : String(e)));
  logger.error(String(e));
  closeRl();
  process.exitCode = 1;
});