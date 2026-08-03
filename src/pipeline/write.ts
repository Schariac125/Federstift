import type { AppConfig } from '../core/config';
import { getActiveProvider, setApprovalMode } from '../core/config';
import { createLLM, type LLMClientLike } from '../core/llm';
import { logger } from '../core/logger';
import { newId, nowIso } from '../core/storage';
import type { KbService } from '../kb/service';
import type { SettingEntry, StyleEntry } from '../kb/types';
import { planNovel, revisePlan, diagnoseRewrite } from '../agents/planner';
import { writeSegment, planChapterRewrite } from '../agents/writer';
import type { WriteSegmentInput, ChapterRewritePlan } from '../agents/writer';
import { reviewChapter, macroCheck, normalizeStrictness, STRICTNESS_LABEL, buildRewriteDirective, decideReviewAction } from '../agents/reviewer';
import type { ReviewReport, ReviewStrictness } from '../agents/reviewer';
import type { ChapterPlan, CreationPlan } from '../agents/types';
import { buildRagContext, renderContext, emptyRetrieval, newChapterIndexCache, settingsSummaryByRelevance } from '../rag/context';
import type { IndexSources } from '../rag/indexer';
import { ask, askChoice, askConfirm, askMultiline, divider, pressEnter } from '../cli/interactive';
import { paint, ok, muted, heading } from '../cli/ui';
import type { ApprovalMode } from '../core/types';
import { listNovels, loadNovel, newNovel, novelDir, saveNovel, saveNovelDelta, buildMacroCheckText } from './novel';
import { listUnprocessedFeedback, recordFeedback } from '../learning/feedback';
import type { FeedbackRecord } from '../learning/feedback';
import type { AuthorNote, NovelState, ReviewRecord } from './novel';

export interface WriteOptions {
  resumeId?: string;
  requirement?: string;
  title?: string;
  targetChapters?: number;
  chapters?: number;
  segmentsPerChapter?: number;
  forceDemo?: boolean;
}

/**
 * 阶段 3 创作流：
 * 总规划 Agent → 深度 RAG → 创作 Agent → 审批网关 → 审查 Agent（章节/宏观）→ 反馈记录
 */
export async function startWriting(
  cfg: AppConfig,
  service: KbService,
  opts: WriteOptions = {}
): Promise<void> {
  const provider = getActiveProvider(cfg);
  const llm = createLLM(opts.forceDemo ? { ...provider, id: 'demo', apiKey: '', model: 'demo' } : provider);
  if (llm.isDemo) {
    divider('离线演示模式');
    console.log(paint.dim('当前没有可用的模型密钥，将使用内置演示引擎体验完整流程（含规划与审查）。'));
    console.log(paint.dim('正式创作请先在「模型与设置」里配置 API Key。') + '\n');
  }

  let novel: NovelState | null = null;
  let chaptersNow = 1;
  if (opts.resumeId) {
    novel = loadNovel(opts.resumeId);
    if (!novel) { console.log('未找到该作品：' + opts.resumeId); return; }
  } else {
    const created = await createNovelInteractive(cfg, service, opts);
    if (!created) return;
    novel = created.novel;
    chaptersNow = created.chaptersNow;
  }
  const state = novel;

  // ---- 总规划 Agent ----
  if (!state.plan) {
    const plan = await runPlanner(cfg, service, state, llm);
    state.plan = plan;
    saveNovel(state);
    showPlanSummary(plan);
    if (plan.questions.length) {
      console.log('\n规划师认为开写前需要先确认几个问题（直接回车可跳过）：');
      for (const q of plan.questions) {
        await askAuthorQuestion(state, 0, q);
      }
      saveNovelDelta(state);
    }
  } else {
    console.log('\n续写作品：已完成 ' + state.chapters.length + ' 章 / 计划 ' + state.plan.chapters.length + ' 章');
  }

  const plan = state.plan;
  const remaining = plan.chapters.slice(state.chapters.length);
  const chaptersThisSession = Math.min(opts.chapters ?? chaptersNow, remaining.length);
  if (!remaining.length) {
    console.log('计划章节已全部写完。可以从主菜单「开始创作」继续拓展，或直接编辑 workspace 里的稿子。');
    await pressEnter();
    return;
  }
  // RAG 章节索引缓存：逐章增量切块 + BM25 分量，只重建变化章节
  const ragChapterCache = newChapterIndexCache();
  // 审查记录脏标记：审查发生后按需重写 reviews.md，避免每段全量重写
  const dirty = { reviews: false };
  const allSettings = service.listSettings();
  const allStyles = service.listStyles();
  const usedSettings = allSettings.filter((s) => state.selectedSettingIds.includes(s.id));
  const usedStyles = allStyles.filter((s) => state.selectedStyleIds.includes(s.id));
  const settingPool = usedSettings.length ? usedSettings : allSettings;
  const stylePool = usedStyles.length ? usedStyles : allStyles;

  let fixDirective = '';
  let rewritePlan: ChapterRewritePlan | null = null;
  const rewriteCounts = new Map<number, number>();
  const autoRewrites = new Map<number, number>();
  const planRevises = { n: 0 };
  for (let wi = 0; wi < chaptersThisSession; wi++) {
    const cp = remaining[wi];
    const chOrder = state.chapters.length + 1;
    const chTitle = cp.title || '第 ' + chOrder + ' 章';
    const chHead = '第 ' + chOrder + ' 章 · ' + chTitle;
    console.log('\n' + paint.cyan('┌── ' + chHead + ' ' + '─'.repeat(Math.max(0, 42 - chHead.length)) + '┐'));
    console.log(paint.dim('│ 目标：' + cp.goal));
    console.log(paint.cyan('└' + '─'.repeat(46) + '┘'));
    if (cp.questions.length) {
      console.log('\n规划师建议先确认本章问题（回车可跳过）：');
      for (const q of cp.questions) {
        await askAuthorQuestion(state, chOrder, q);
      }
      saveNovelDelta(state);
    }
    const chapter: { order: number; title: string; segments: { order: number; text: string; userEdited?: boolean; original?: string }[] } = { order: chOrder, title: chTitle, segments: [] };
    state.chapters.push(chapter);

    const segmentsPer = opts.segmentsPerChapter ?? cp.segments;
    let interrupted = false;
    let chDone = false;
    while (!chDone && !interrupted) {
      // 段生成：按缺失段号补齐（定向重写后中间段可能缺失）
      let nextOrder = nextMissingOrder(chapter, segmentsPer);
      while (nextOrder !== null) {
        const segOrder = nextOrder;
      const recent = recentText(state, chOrder);
      const query = [state.requirement, chTitle, cp.goal, recent.slice(-300)].join(' ');
      const sources: IndexSources = { settings: settingPool, styles: stylePool, chapters: state.chapters, notes: state.authorNotes };
      const retrieved = cfg.rag.enabled ? buildRagContext(query, sources, cfg.rag, ragChapterCache) : emptyRetrieval();
      const context = renderContext(retrieved, recent);
      const nextBeat = cp.beats[segOrder - 1] ?? '';
      const input: WriteSegmentInput = {
        requirement: state.requirement,
        context,
        chapterGoal: chTitle + '：' + cp.goal,
        nextBeat,
        fixDirective: segmentFixDirective(rewritePlan, fixDirective, segOrder),
      };
      process.stdout.write(paint.dim('⠋ 创作中…'));
      let text = '';
      try {
        text = await writeSegment(llm, input, 0.85, undefined, cfg.writerSystemPrompt);
      } catch (e) {
        console.log('\n生成失败：' + (e instanceof Error ? e.message : String(e)));
        const retry = await askConfirm('重试这段？', true);
        if (retry) continue;
        interrupted = true;
        break;
      }
      process.stdout.write('\r' + paint.green('✔ ') + '本段完成\n');

      const decision = await approvalGate(cfg, state, chOrder, segOrder, text, llm, input);
      if (decision.kind === 'stop') { interrupted = true; break; }
      if (decision.kind === 'reject') {
        continue;
      }
      const seg = { order: segOrder, text: decision.text, userEdited: decision.userEdited, original: decision.original };
      upsertSegment(chapter, seg);
      if (decision.userEdited) {
        recordFeedback({
          id: newId('fb'),
          novelId: state.id,
          chapter: chOrder,
          segment: segOrder,
          original: decision.original ?? '',
          edited: decision.text,
          ts: nowIso(),
        });
        logger.info(`反馈已记录：第${chOrder}章 第${segOrder}段`);
      }
      saveNovelDelta(state);
      nextOrder = nextMissingOrder(chapter, segmentsPer);
    }

    if (interrupted) break;
    if (cfg.approvalMode === 'chapter') {
      let gate = await chapterGate(cfg, state, chapter);
      while (gate === 'mode') {
        await switchApprovalMode(cfg, state);
        gate = await chapterGate(cfg, state, chapter);
      }
      if (gate === 'redo') {
        // 整章重写：清空本章段落重新生成（不再 pop + wi--）
        chapter.segments = [];
        rewriteCounts.set(chOrder, (rewriteCounts.get(chOrder) ?? 0) + 1);
        fixDirective = '';
        rewritePlan = null;
        saveNovel(state);
        continue;
      }
      if (gate === 'stop') { interrupted = true; break; }
    }

    // ---- 审查 Agent：规划指定章节 + 每 N 章宏观一致性检查 ----
    const review = await runReviewPoints(cfg, service, state, llm, chapter, cp, chOrder, dirty, { rewriteCounts, autoRewrites, planRevises });
    saveNovelDelta(state, { reviews: dirty.reviews });
    if (review.redo) {
      if (review.rewritePlan && review.rewritePlan.segments.length) {
        // 定向重写：只删目标段，段循环按缺失段号补齐
        const targets = new Set(review.rewritePlan.segments.map((x) => x.order));
        chapter.segments = chapter.segments.filter((x) => !targets.has(x.order));
      } else {
        // 整章重写：清空本章段落重新生成
        chapter.segments = [];
      }
      fixDirective = review.fixDirective;
      rewritePlan = review.rewritePlan ?? null;
      saveNovel(state);
      continue;
    }
    fixDirective = ''; // 本章已通过审查，下一章不再携带修改要求
    rewritePlan = null;
    chDone = true;
    }

    const contChoices = [
      { key: 'yes', label: '继续写下一章', value: 'yes' as const },
      { key: 'mode', label: '切换审批模式', value: 'mode' as const },
      { key: 'stop', label: '停止本轮创作', value: 'stop' as const }
    ];
    let cont = await askChoice<'yes' | 'mode' | 'stop'>('本章完成', contChoices, 'yes');
    while (cont === 'mode') {
      await switchApprovalMode(cfg, state);
      cont = await askChoice<'yes' | 'mode' | 'stop'>('本章完成', contChoices, 'yes');
    }
    if (cont === 'stop') break;
  }

  const unlearned = listUnprocessedFeedback().length;
  if (unlearned > 0) {
    console.log('\n提示：已有 ' + unlearned + ' 条你的修改记录，可在「知识库管理 → 反馈学习」提炼为风格偏好。');
  }
  divider('本轮创作结束');
  console.log(paint.bold('作品目录：') + novelDir(state.id));
  console.log(paint.bold('稿子：') + novelDir(state.id) + '\\manuscript.md' + paint.dim(' · 计划：') + novelDir(state.id) + '\\plan.md' + paint.dim(' · 审查：') + novelDir(state.id) + '\\reviews.md');
  await pressEnter();
}

async function runPlanner(
  cfg: AppConfig,
  service: KbService,
  state: NovelState,
  llm: LLMClientLike
) {
  divider('总规划 Agent · 制定全局策略');
  console.log('（规划师正在理解你的意图：题材、基调、先写什么、何时提问、何时审查...）');
  const styles = service.listStyles();
  const settings = service.listSettings();
  const styleRules = styles
    .filter((s) => state.selectedStyleIds.includes(s.id))
    .flatMap((s) => s.rules);
  const settingsSummary = settingsSummaryByRelevance(settings, state.requirement, 12);
  const target = Math.min(50, Math.max(1, state.planTarget ?? 10));
  return planNovel(llm, {
    requirement: state.requirement,
    styleRules,
    settingsSummary,
    approvalMode: state.approvalMode,
    targetChapters: target,
  }, cfg.plannerSystemPrompt);
}

function showPlanSummary(plan: CreationPlan): void {
  divider('总规划 Agent · 创作计划');
  console.log(paint.bold('理解：') + plan.premise);
  console.log('\n' + paint.bold('策略：') + plan.strategy);
  if (plan.styleDirectives.length) {
    console.log('\n' + paint.bold('风格把控：'));
    plan.styleDirectives.forEach((d) => console.log('  · ' + d));
  }
  console.log('\n' + paint.bold('审查时机：') + plan.reviewSchedule);
  console.log('\n' + paint.bold('章节计划（共 ' + plan.chapters.length + ' 章）：'));
  plan.chapters.forEach((c) => {
    console.log('  ' + paint.cyan(String(c.order).padStart(2, ' ') + '.') + ' ' + c.title + (c.reviewAfter ? paint.yellow('（章末审查）') : '') + paint.dim(' —— ' + c.goal.slice(0, 26)));
  });
}

async function askAuthorQuestion(state: NovelState, chapter: number, question: string): Promise<void> {
  const answer = (await ask('？' + question + '（回车跳过）')).trim();
  if (!answer) return;
  state.authorNotes.push({ chapter, question, answer, ts: nowIso() });
  console.log('✔ 已记下你的答复，后续创作会作为设定持续生效。');
}

function recentText(state: NovelState, chapterOrder: number): string {
  const out: string[] = [];
  for (const ch of state.chapters) {
    if (ch.order > chapterOrder) break;
    for (const seg of ch.segments) out.push(seg.text);
  }
  return out.join('\n\n');
}

interface ApprovalDecision {
  kind: 'accept' | 'stop' | 'reject';
  text: string;
  userEdited?: boolean;
  original?: string;
}

async function approvalGate(
  cfg: AppConfig,
  state: NovelState,
  chapter: number,
  segOrder: number,
  text: string,
  llm: LLMClientLike,
  input: WriteSegmentInput
): Promise<ApprovalDecision> {
  const mode = cfg.approvalMode;
  if (mode === 'auto') {
    console.log('\n——— 第 ' + chapter + ' 章 · 第 ' + segOrder + ' 段 ———');
    console.log(text);
    return { kind: 'accept', text };
  }
  if (mode === 'segment') {
    while (true) {
      console.log('\n' + paint.cyan('── 第 ' + chapter + ' 章 · 第 ' + segOrder + ' 段 ──'));
      console.log(text);
      const choice = await askChoice<string>(
        '这段怎么处理？',
        [
          { key: 'ok', label: '批准，继续', value: 'ok' },
          { key: 'edit', label: '修改这段（输入你的版本）', value: 'edit' },
          { key: 'redo', label: '重写这段', value: 'redo' },
          { key: 'back', label: '打回（回到上一段）', value: 'back' },
          { key: 'mode', label: '切换审批模式', value: 'mode' },
          { key: 'stop', label: '停止本轮创作', value: 'stop' }
        ],
        'ok'
      );
      if (choice === 'ok') return { kind: 'accept', text };
      if (choice === 'stop') return { kind: 'stop', text };
      if (choice === 'back') {
        const ch = state.chapters[state.chapters.length - 1];
        ch.segments.pop();
        saveNovel(state);
        return { kind: 'reject', text };
      }
      if (choice === 'mode') {
        await switchApprovalMode(cfg, state);
        continue;
      }
      if (choice === 'edit') {
        const edited = await askMultiline('输入修改后的版本');
        if (edited.trim()) return { kind: 'accept', text: edited.trim(), userEdited: true, original: text };
      }
      if (choice === 'redo') {
        try {
          const newText = await writeSegment(llm, { ...input, fixDirective: undefined }, 1.05, undefined, cfg.writerSystemPrompt);
          console.log('\n' + paint.cyan('── 重写后 ──'));
          console.log(newText);
          text = newText;
        } catch (e) {
          console.log('重写失败：' + (e instanceof Error ? e.message : String(e)));
        }
      }
    }
  }
  console.log('\n' + paint.cyan('── 第 ' + chapter + ' 章 · 第 ' + segOrder + ' 段（章末统一确认）──'));
  console.log(text);
  return { kind: 'accept', text };
}

async function chapterGate(
  cfg: AppConfig,
  state: NovelState,
  chapter: { order: number; title: string; segments: { order: number; text: string; userEdited?: boolean; original?: string }[] }
): Promise<'ok' | 'redo' | 'stop' | 'mode'> {
  divider('第 ' + chapter.order + ' 章 · 整章确认');
  for (const seg of chapter.segments) {
    console.log(seg.text + '\n');
  }
  const choice = await askChoice<string>(
    '这一章怎么样？',
    [
      { key: 'ok', label: '批准这一章', value: 'ok' },
      { key: 'redo', label: '整章重写（将重新生成本章）', value: 'redo' },
      { key: 'mode', label: '切换审批模式', value: 'mode' },
      { key: 'stop', label: '停止本轮创作', value: 'stop' }
    ],
    'ok'
  );
  if (choice === 'redo') return 'redo';
  if (choice === 'mode') return 'mode';
  return choice === 'stop' ? 'stop' : 'ok';
}

/** 审查入口：规划指定章节审查 + 每 N 章宏观一致性检查 */
/** 审查流程的会话级计数（CLI 局部状态，跨章节/重写共享） */
interface ReviewCtx {
  rewriteCounts: Map<number, number>;
  autoRewrites: Map<number, number>;
  planRevises: { n: number };
}

async function runReviewPoints(
  cfg: AppConfig,
  service: KbService,
  state: NovelState,
  llm: LLMClientLike,
  chapter: { order: number; title: string; segments: { order: number; text: string }[] },
  cp: ChapterPlan,
  chOrder: number,
  dirty: { reviews: boolean },
  ctx: ReviewCtx
): Promise<{ redo: boolean; fixDirective: string; rewritePlan?: ChapterRewritePlan | null; report?: ReviewReport; auto?: boolean }> {
  const doChapterReview = Boolean(cp.reviewAfter);
  const doMacro = chOrder % cfg.macroCheckInterval === 0;
  if (!doChapterReview && !doMacro) return { redo: false, fixDirective: '' };

  const settings = service.listSettings();
  const chapterText = chapter.segments.map((s) => s.text).join('\n\n');
  const settingsSummary = settingsSummaryByRelevance(settings, chapterText + '\n' + cp.goal, 12);
  const styleRules = service
    .listStyles()
    .filter((s) => state.selectedStyleIds.includes(s.id))
    .flatMap((s) => s.rules);

  const focus = (state.reviewFocus ?? '').trim() || (cfg.reviewFocus ?? '').trim();
  const strictness = normalizeStrictness(state.reviewStrictness ?? cfg.reviewStrictness);
  const autoMode = cfg.approvalMode === 'auto';

  // 统一的重写准备：P1b 反复返工诊断 + 重写方案（定向重写由主循环按方案段落落实）
  const prepareRedo = async (report: ReviewReport): Promise<{ redo: true; fixDirective: string; rewritePlan: ChapterRewritePlan | null; report: ReviewReport; auto: boolean }> => {
    const count = (ctx.rewriteCounts.get(chOrder) ?? 0) + 1;
    ctx.rewriteCounts.set(chOrder, count);
    let diagnosis: string | null = null;
    if (count >= REWRITE_DIAGNOSE_MIN) {
      diagnosis = await diagnoseRewrite(llm, {
        requirement: state.requirement,
        chapterTitle: chapter.title,
        chapterGoal: cp.goal,
        chapterText: chapter.segments.map((s) => s.text).join('\n\n'),
        report,
        pastDirectives: [],
      });
    }
    if (diagnosis) console.log(paint.yellow('（总规划 Agent 诊断：' + (diagnosis.length > 120 ? diagnosis.slice(0, 120) + '…' : diagnosis) + '）'));
    const rewritePlan = await planChapterRewrite(llm, {
      requirement: state.requirement,
      chapterTitle: chapter.title,
      chapterGoal: cp.goal,
      chapterText: chapter.segments.map((s) => s.text).join('\n\n'),
      report,
      diagnosis: diagnosis ?? undefined,
    });
    return { redo: true, fixDirective: buildRewriteDirective(report), rewritePlan, report, auto: autoMode };
  };

  if (doChapterReview) {
    divider('审查 Agent · 第 ' + chOrder + ' 章');
    if (focus) console.log(paint.dim('本次审查重点：' + focus));
    console.log(paint.dim('审查力度：' + STRICTNESS_LABEL[strictness].split('：')[0]));
    const report = await reviewChapter(llm, { text: chapterText, goal: cp.goal, settingsSummary, styleRules, scope: '本章', focus, strictness });
    showReview(report);
    recordReview(state, 'chapter', chOrder, report);
    dirty.reviews = true;
    if (!autoMode) {
      // 非自动模式：审查报告呈现给作者判断
      let act = await reviewActionMenu('如何处理审查意见？');
      while (act === 'strictness') {
        await adjustStrictness(state, cfg);
        act = await reviewActionMenu('如何处理审查意见？');
      }
      if (act === 'redo') return prepareRedo(report);
    } else {
      // 自动模式：规则层裁决（0 次额外 LLM 调用）；自动重写最多 AUTO_REWRITE_MAX 次
      const decision = decideReviewAction(report);
      if (decision !== 'ignore') {
        const rewrites = ctx.autoRewrites.get(chOrder) ?? 0;
        if (rewrites >= AUTO_REWRITE_MAX) {
          console.log(paint.dim('（自动模式：本章已自动重写 ' + rewrites + ' 次仍未通过，保留当前版本继续）'));
        } else {
          ctx.autoRewrites.set(chOrder, rewrites + 1);
          return prepareRedo(report);
        }
      }
    }
  }

  if (doMacro) {
    divider('宏观一致性检查 · 第 ' + chOrder + ' 章');
    if (focus) console.log(paint.dim('本次审查重点：' + focus));
    console.log(paint.dim('审查力度：' + STRICTNESS_LABEL[strictness].split('：')[0]));
    const report = await macroCheck(llm, { text: buildMacroCheckText(state.chapters), goal: state.requirement, settingsSummary, styleRules, scope: '全书（宏观一致性）', focus, strictness });
    showReview(report);
    recordReview(state, 'macro', chOrder, report);
    dirty.reviews = true;
    if (!autoMode) {
      // 非自动模式：宏观报告呈现给作者判断
      let act = await reviewActionMenu('如何处理宏观检查意见？');
      while (act === 'strictness') {
        await adjustStrictness(state, cfg);
        act = await reviewActionMenu('如何处理宏观检查意见？');
      }
      if (act === 'redo') return prepareRedo(report);
    } else {
      // 自动模式：宏观不过 → P1a 总规划 Agent 修订创作计划（每作品最多 PLAN_REVISE_MAX 次），正文不重写
      if (!report.passed && ctx.planRevises.n < PLAN_REVISE_MAX) {
        const chaptersSummary = state.chapters.map((c) => '第 ' + c.order + ' 章 ' + c.title).join('；') + '（已写 ' + state.chapters.length + ' 章）';
        const revised = await revisePlan(llm, {
          requirement: state.requirement,
          plan: state.plan ?? { premise: '', strategy: '', styleDirectives: [], questions: [], reviewSchedule: '', chapters: [] },
          report,
          chaptersSummary,
        });
        if (revised) {
          state.plan = revised;
          ctx.planRevises.n++;
          console.log(paint.yellow('（宏观检查发现计划级问题，总规划 Agent 已修订创作计划）'));
        }
      }
    }
  }
  return { redo: false, fixDirective: '', rewritePlan: null };
}

function showReview(report: ReviewReport): void {
  const passTag = report.passed ? paint.green('通过') : paint.yellow('未通过');
  console.log(paint.bold('总分 ' + report.score.overall) + '（' + passTag + '）');
  console.log(paint.dim('情节 ' + report.score.plot + ' · 人物 ' + report.score.character + ' · 设定一致 ' + report.score.settingConsistency + ' · 文风 ' + report.score.style + ' · 逻辑 ' + report.score.logic + ' · 语言 ' + report.score.language + ' · 节奏 ' + report.score.pacing));
  if (report.issues.length) {
    heading('问题');
    for (const i of report.issues) {
      const tag = i.severity === 'error' ? paint.red('✘') : i.severity === 'warning' ? paint.yellow('!') : paint.dim('·');
      console.log('  ' + tag + ' ' + paint.cyan('[' + i.dimension + ']') + ' ' + i.description);
      if (i.suggestion) console.log('     ' + paint.dim('建议：' + i.suggestion));
    }
  }
  if (report.strengths.length) { heading('优点'); console.log('  ' + report.strengths.join('；')); }
  if (report.suggestions.length) { heading('整体建议'); console.log('  ' + report.suggestions.join('；')); }
}

function recordReview(
  state: NovelState,
  kind: 'chapter' | 'macro',
  chapter: number,
  report: ReviewReport
): void {
  const rec: ReviewRecord = {
    id: newId('rev'),
    kind,
    chapter,
    passed: report.passed,
    score: report.score,
    issues: report.issues,
    strengths: report.strengths,
    suggestions: report.suggestions,
    ts: nowIso(),
  };
  state.reviews.push(rec);
}

/** 审查意见处理菜单：重写 / 调整下次审查力度 / 忽略 */
async function reviewActionMenu(prompt: string): Promise<'redo' | 'ignore' | 'strictness'> {
  return askChoice<'redo' | 'ignore' | 'strictness'>(prompt, [
    { key: 'redo', label: '重写本章（落实修改意见）', value: 'redo' },
    { key: 'adjust', label: '调整下次审查力度', value: 'strictness' },
    { key: 'ignore', label: '忽略，继续创作（报告已存档）', value: 'ignore' }
  ], 'ignore');
}

/** 调整当前作品的审查力度（作品级，覆盖全局默认） */
async function adjustStrictness(state: NovelState, cfg: AppConfig): Promise<void> {
  const cur = normalizeStrictness(state.reviewStrictness ?? cfg.reviewStrictness);
  const next = await askChoice<ReviewStrictness>('下次审查力度', [
    { key: 's', label: STRICTNESS_LABEL.strict, value: 'strict' },
    { key: 'b', label: STRICTNESS_LABEL.standard, value: 'standard' },
    { key: 'l', label: STRICTNESS_LABEL.lenient, value: 'lenient' }
  ], cur);
  state.reviewStrictness = next;
  saveNovel(state);
  console.log('✔ 已应用：' + STRICTNESS_LABEL[next].split('：')[0] + '（本次作品后续审查生效；全局默认可在「模型与设置」调整）');
}

/** 创作中切换审批模式：全局默认与当前作品同步，立即生效 */
async function switchApprovalMode(cfg: AppConfig, state: NovelState): Promise<void> {
  const mode = await askChoice<ApprovalMode>('切换审批模式（立即生效）', [
    { key: 'a', label: '自动：生成即采纳，安静流淌（推荐）', value: 'auto' },
    { key: 's', label: '逐段：每段确认/修改/重写', value: 'segment' },
    { key: 'c', label: '逐章：章末统一确认', value: 'chapter' }
  ], cfg.approvalMode);
  if (mode !== cfg.approvalMode) {
    setApprovalMode(cfg, mode);
    state.approvalMode = mode;
    saveNovelDelta(state);
    ok('审批模式已切换为「' + (mode === 'auto' ? '自动' : mode === 'segment' ? '逐段' : '逐章') + '」（本作品与全局默认同步）');
  } else {
    muted('审批模式未变（当前已是该模式）。');
  }
}

/** 自动模式下每章最多自动重写的次数（达到后保留当前版本继续，防死循环） */
const AUTO_REWRITE_MAX = 1;
/** 同一章重写达到该次数后，下一次重写前由总规划 Agent 诊断（P1b） */
const REWRITE_DIAGNOSE_MIN = 2;
/** 自动模式下每作品最多进行的计划级修订次数（P1a） */
const PLAN_REVISE_MAX = 1;

/** 按段号插入/覆盖段落（定向重写后用于补齐缺失段） */
function upsertSegment(
  chapter: { order: number; title: string; segments: { order: number; text: string; userEdited?: boolean; original?: string }[] },
  seg: { order: number; text: string; userEdited?: boolean; original?: string }
): void {
  const idx = chapter.segments.findIndex((x) => x.order === seg.order);
  if (idx >= 0) chapter.segments[idx] = seg;
  else {
    chapter.segments.push(seg);
    chapter.segments.sort((a, b) => a.order - b.order);
  }
}

/** 下一个缺失的段号（从 1 到 total）；全部写完返回 null */
function nextMissingOrder(chapter: { segments: { order: number }[] }, total: number): number | null {
  const existing = new Set(chapter.segments.map((x) => x.order));
  for (let o = 1; o <= total; o++) if (!existing.has(o)) return o;
  return null;
}

/** 当前段要携带的重写指令：有整章方案时取「方案 + 本段要点」，否则回落全局 fixDirective */
function segmentFixDirective(rewritePlan: ChapterRewritePlan | null, fixDirective: string, segOrder: number): string {
  if (rewritePlan) {
    const parts = ['【本章重写方案】' + rewritePlan.approach];
    const seg = rewritePlan.segments.find((x) => x.order === segOrder);
    if (seg) parts.push('【本段修改要点】' + seg.fix);
    return parts.join('\n');
  }
  return fixDirective;
}

async function createNovelInteractive(
  cfg: AppConfig,
  service: KbService,
  opts: WriteOptions
): Promise<{ novel: NovelState; chaptersNow: number } | null> {
  divider('开始创作');
  console.log(paint.dim('所有问题都可以直接回车跳过，随时可以停下来。'));
  const title = (await ask('作品名（回车可稍后补）')).trim() || '未命名作品';
  const requirement = (opts.requirement ?? (await askMultiline('你想写一个什么样的故事？（一句话到几段话都可以）'))).trim();
  if (!requirement) {
    console.log('没有创作要求，已取消。');
    return null;
  }
  const useKb = await askConfirm('要不要挂上知识库（风格库/设定库）？不需要也能直接写', false);
  const styleIds: string[] = [];
  const settingIds: string[] = [];
  if (useKb) {
    const styles = service.listStyles();
    if (styles.length) {
      console.log('\n' + paint.bold('可用的风格：'));
      styles.forEach((s, i) => console.log('  ' + paint.cyan(String(i + 1).padStart(2, ' ') + '.') + ' ' + s.name + paint.dim(' —— ' + (s.description || s.rules[0] || ''))));
      const sel = (await ask('选择风格（逗号分隔序号，回车 = 不用风格）')).trim();
      sel.split(/[,，\s]+/).forEach((n) => {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < styles.length) styleIds.push(styles[idx].id);
      });
    } else {
      console.log('（风格库还是空的，可以在「知识库管理」里用范例创建）');
    }
    const settings = service.listSettings();
    if (settings.length) {
      console.log('\n' + paint.bold('可用的设定：'));
      settings.forEach((s, i) => console.log('  ' + paint.cyan(String(i + 1).padStart(2, ' ') + '.') + ' ' + s.name));
      const sel2 = (await ask('选择设定（逗号分隔序号，回车 = 不选，自动按相关性检索）')).trim();
      sel2.split(/[,，\s]+/).forEach((n) => {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < settings.length) settingIds.push(settings[idx].id);
      });
    }
  }
  const targetChapters = Math.min(50, Math.max(1, parseInt((await ask('这本小说大致计划写多少章？（用于全局规划）', '10')).trim(), 10) || 10));
  const chaptersNow = Math.min(5, Math.max(1, parseInt((await ask('这次会话先写几章？', '1')).trim(), 10) || 1));
  const reviewFocus = (await ask('重点审查什么方向？（如：设定一致性、人物动机、文风节奏；回车 = 用全局默认）')).trim();
  const reviewStrictness = await askChoice<ReviewStrictness>('审查力度（影响每次审查的严格程度；每次审查后也可随时调整）', [
    { key: 's', label: '严格：从严审查，轻微问题也列出', value: 'strict' },
    { key: 'b', label: '标准：常规审查（推荐）', value: 'standard' },
    { key: 'l', label: '宽松：只报重大问题，不打扰', value: 'lenient' }
  ], normalizeStrictness(cfg.reviewStrictness));
  const novel = newNovel({
    title,
    requirement,
    approvalMode: cfg.approvalMode,
    selectedStyleIds: styleIds,
    selectedSettingIds: settingIds,
    planTarget: targetChapters,
    reviewFocus,
    reviewStrictness,
  });
  saveNovel(novel);
  return { novel, chaptersNow };
}

export async function resumeMenu(): Promise<string | null> {
  const novels = listNovels();
  if (!novels.length) {
    console.log('还没有作品。');
    return null;
  }
  console.log('\n' + paint.bold('作品列表：'));
  novels.forEach((n, i) => {
    const chs = n.chapters.length;
    const segs = n.chapters.reduce((a, c) => a + c.segments.length, 0);
    console.log('  ' + paint.cyan(String(i + 1).padStart(2, ' ') + '.') + ' ' + n.title + paint.dim('（' + chs + ' 章 / ' + segs + ' 段）') + (n.requirement ? paint.dim(' —— ' + n.requirement.slice(0, 20)) : ''));
  });
  const sel = (await ask('选择要续写的作品序号，回车 = 返回')).trim();
  if (!sel) return null;
  const idx = parseInt(sel, 10) - 1;
  if (idx >= 0 && idx < novels.length) return novels[idx].id;
  return null;
}