/**
 * GUI 会话引擎：把「规划 → 分段写作 → 审批 → 审查 → 反馈」流水线封装成
 * 可暂停/可恢复的状态机。每次 advance() 尽可能推进，直到：
 *  - 需要作者回答规划/章节问题（可全部跳过）
 *  - 审批模式需要作者决策（逐段/逐章）
 *  - 审查报告需要作者决策（重写/调整力度/忽略）
 *  - 一章完成，询问是否继续
 * 或整本完成。状态通过 snapshot() 输出给前端。
 */
import type { AppConfig } from '../core/config';
import { getActiveProvider, setApprovalMode } from '../core/config';
import { createLLM, type LLMClientLike } from '../core/llm';
import { newId, nowIso } from '../core/storage';
import type { KbService } from '../kb/service';
import { planNovel, revisePlan, diagnoseRewrite } from '../agents/planner';
import { writeSegment, planChapterRewrite } from '../agents/writer';
import type { ChapterRewritePlan } from '../agents/writer';
import type { WriteSegmentInput } from '../agents/writer';
import { reviewChapter, macroCheck, normalizeStrictness, STRICTNESS_LABEL, buildRewriteDirective, decideReviewAction } from '../agents/reviewer';
import type { ReviewReport, ReviewStrictness } from '../agents/reviewer';
import type { ChapterPlan, CreationPlan } from '../agents/types';
import { buildRagContext, renderContext, emptyRetrieval, newChapterIndexCache, settingsSummaryByRelevance } from '../rag/context';
import type { IndexSources } from '../rag/indexer';
import type { ApprovalMode } from '../core/types';
import { loadNovel, newNovel, saveNovel, saveNovelDelta, buildMacroCheckText } from '../pipeline/novel';
import type { Chapter, ChapterSegment, NovelState } from '../pipeline/novel';
import { listUnprocessedFeedback, recordFeedback } from '../learning/feedback';
import { logger } from '../core/logger';

export type SessionStatus =
  | 'writing' // 推进中（advance 调用期间）
  | 'questions' // 等待回答规划/章节问题
  | 'segment' // 逐段审批：等待处理某段
  | 'chapter' // 逐章审批：等待整章确认
  | 'review' // 非自动模式：等待处理审查意见
  | 'chapter_done' // 本章完成：继续 / 切换模式 / 停止
  | 'finished' // 计划章节全部完成
  | 'stopped'; // 用户主动停止

export type PendingDecision =
  | { kind: 'questions'; chapter: number; questions: string[] }
  | { kind: 'segment'; chapter: number; segOrder: number; text: string }
  | { kind: 'chapter'; chapter: number; title: string; text: string }
  | { kind: 'review'; reviewKind: 'chapter' | 'macro'; chapter: number; report: ReviewReport }
  | { kind: 'chapter_done'; chapter: number };

export interface SessionLogEntry {
  ts: string;
  type: 'plan' | 'segment' | 'review' | 'note' | 'feedback' | 'mode' | 'info' | 'error';
  text: string;
}

/** 流式推进事件（GUI 通过 SSE 实时展示创作过程） */
export type SessionStreamEvent =
  | { type: 'log'; text: string }
  | { type: 'segment'; chapter: number; segOrder: number; title: string; goal: string }
  | { type: 'text'; delta: string }
  | { type: 'review'; text: string };

export interface SessionSnapshot {
  novelId: string;
  title: string;
  requirement: string;
  status: SessionStatus;
  approvalMode: ApprovalMode;
  provider: { name: string; model: string; isDemo: boolean };
  plan?: CreationPlan;
  chapters: Chapter[];
  reviews: NovelState['reviews'];
  authorNotes: NovelState['authorNotes'];
  pending: PendingDecision | null;
  fixDirective: string;
  log: SessionLogEntry[];
  allDone: boolean;
  feedbackPending: number;
  strictness: ReviewStrictness;
}

export interface CreateNovelOptions {
  title?: string;
  requirement: string;
  styleIds?: string[];
  settingIds?: string[];
  templateIds?: string[];
  planTarget?: number;
  approvalMode?: ApprovalMode;
  reviewFocus?: string;
  reviewStrictness?: ReviewStrictness;
}

export class GuiSession {
  readonly cfg: AppConfig;
  readonly service: KbService;
  readonly llm: LLMClientLike;
  state: NovelState;

  private pending: PendingDecision | null = null;
  /** 本会话内已跳过（未回答）的问题，避免重复打扰 */
  private dismissed = new Set<string>();
  private fixDirective = '';
  /** 整章重写的方案（审查意见驱动）：按段落分配修改要点，逐段注入，失败回落结构化指令 */
  private rewritePlan: ChapterRewritePlan | null = null;
  /** 每章已重写次数（含用户打回；P1b 反复返工时触发总规划诊断） */
  private rewriteCounts = new Map<number, number>();
  /** 自动模式每章已自动重写次数（上限 AUTO_REWRITE_MAX，防止审查不过的死循环） */
  private autoRewrites = new Map<number, number>();
  /** 自动模式已进行的计划级修订次数（每作品最多 PLAN_REVISE_MAX 次） */
  private planRevises = 0;
  private log: SessionLogEntry[] = [];
  private status: SessionStatus = 'writing';
  /** 已完成（正文写满且通过审查）的章数游标；决定下一章写哪一章 */
  private doneChapters = 0;
  /** 当前章节实例的审查进度（redo 重写后重置） */
  private reviewProgress: { chapter: number; chapterDone: boolean; macroDone: boolean } | null = null;
  /** 推进锁：防止并发 advance 破坏状态 */
  private busyFlag = false;
  /** RAG 章节索引缓存：逐章增量切块 + BM25 分量，只重建变化章节 */
  private ragChapterCache = newChapterIndexCache();
  /** plan / reviews 自上次写盘后是否已变化（增量保存时按需重写对应 md） */
  private planDirty = false;
  private reviewsDirty = false;

  constructor(cfg: AppConfig, service: KbService, novel: NovelState) {
    this.cfg = cfg;
    this.service = service;
    this.state = novel;
    const provider = getActiveProvider(cfg);
    this.llm = createLLM(provider);
    this.doneChapters = this.computeDoneChapters();
  }

  static async create(cfg: AppConfig, service: KbService, opts: CreateNovelOptions): Promise<GuiSession> {
    const novel = newNovel({
      title: opts.title?.trim() || '未命名作品',
      requirement: opts.requirement.trim(),
      approvalMode: opts.approvalMode ?? cfg.approvalMode,
      selectedStyleIds: opts.styleIds ?? [],
      selectedSettingIds: opts.settingIds ?? [],
      selectedTemplateIds: opts.templateIds ?? [],
      planTarget: Math.min(50, Math.max(1, opts.planTarget ?? 10)),
      reviewFocus: opts.reviewFocus?.trim() || undefined,
      reviewStrictness: opts.reviewStrictness ? normalizeStrictness(opts.reviewStrictness) : undefined,
    });
    saveNovel(novel);
    // 规划推迟到首次推进时流式完成，让「开始创作」能立即进入创作台页面
    return new GuiSession(cfg, service, novel);
  }

  static resume(cfg: AppConfig, service: KbService, novelId: string): GuiSession | null {
    const novel = loadNovel(novelId);
    if (!novel) return null;
    return new GuiSession(cfg, service, novel);
  }

  /** 当前生效的审批模式：作品级优先，回落全局默认 */
  private mode(): ApprovalMode {
    return this.state.approvalMode ?? this.cfg.approvalMode;
  }

  /**
   * 保存快照：默认增量（session.json 全量 + manuscript.md 增量追加，
   * plan/reviews 按脏标记按需重写）；full=true 时全量重写（弹章/打回等）。
   */
  private persist(full?: boolean): void {
    if (full) {
      saveNovel(this.state);
    } else {
      saveNovelDelta(this.state, { plan: this.planDirty, reviews: this.reviewsDirty });
    }
    this.planDirty = false;
    this.reviewsDirty = false;
  }

  /** 从已有章节计算「已完成章数」：从头数起，正文写满的章才算完成（支持中断后恢复） */
  private computeDoneChapters(): number {
    const plan = this.state.plan;
    if (!plan) return 0;
    let n = 0;
    for (let i = 0; i < this.state.chapters.length && i < plan.chapters.length; i++) {
      const ch = this.state.chapters[i];
      if (ch.segments.length >= plan.chapters[i].segments) n++;
      else break;
    }
    return n;
  }

  // ---------------- 规划 ----------------

  private async ensurePlan(): Promise<void> {
    if (this.state.plan) {
      this.logEntry('info', '已加载创作计划（续写模式）');
      return;
    }
    const styles = this.service.listStyles();
    const settings = this.service.listSettings();
    const styleRules = styles.filter((s) => this.state.selectedStyleIds.includes(s.id)).flatMap((s) => s.rules);
    const settingsSummary = settingsSummaryByRelevance(settings, this.state.requirement, 12);
    const target = Math.min(50, Math.max(1, this.state.planTarget ?? 10));
    const plan = await planNovel(this.llm, {
      requirement: this.state.requirement,
      styleRules,
      settingsSummary,
      approvalMode: this.state.approvalMode,
      targetChapters: target,
    }, this.cfg.plannerSystemPrompt);
    this.state.plan = plan;
    this.planDirty = true;
    this.persist();
    this.logEntry('plan', '总规划 Agent 完成全局策略：' + plan.premise);
    this.logEntry('info', '计划 ' + plan.chapters.length + ' 章 · 审查安排：' + plan.reviewSchedule);
    if (plan.questions.length) {
      this.status = 'questions';
      this.pending = { kind: 'questions', chapter: 0, questions: plan.questions };
    }
  }

  /** 随时调整本作品的审查力度（影响下次审查） */
  async setStrictness(s: ReviewStrictness): Promise<SessionSnapshot> {
    const next = normalizeStrictness(s);
    this.state.reviewStrictness = next;
    this.persist();
    this.logEntry('mode', '审查力度调整为：' + STRICTNESS_LABEL[next].split('：')[0]);
    return this.snapshot();
  }

  // ---------------- 主推进 ----------------

  /** 是否正在推进（避免并发触发创作） */
  get busy(): boolean {
    return this.busyFlag;
  }

  /** 推进创作，直到需要作者决策或全部完成。可传入 emit 实时回调流式事件。 */
  async advance(emit?: (ev: SessionStreamEvent) => void): Promise<SessionSnapshot> {
    if (this.busyFlag) throw new Error('已有创作任务进行中，请稍候');
    this.busyFlag = true;
    try {
      return await this.runAdvance(emit);
    } finally {
      this.busyFlag = false;
    }
  }

  private async runAdvance(emit?: (ev: SessionStreamEvent) => void): Promise<SessionSnapshot> {
    if (this.status === 'finished') return this.snapshot();
    if (this.status === 'stopped') this.status = 'writing'; // 停止后可继续
    const plan = this.state.plan;
    if (!plan) {
      emit?.({ type: 'log', text: '总规划 Agent 正在制定全局策略…' });
      await this.ensurePlan();
      if (!this.state.plan) return this.snapshot();
      if (this.pending) return this.snapshot();
    }

    while (true) {
      if (this.doneChapters >= plan!.chapters.length) {
        this.status = 'finished';
        this.pending = null;
        this.persist(true);
        this.logEntry('info', '计划章节已全部完成。');
        return this.snapshot();
      }

      const chOrder = this.doneChapters + 1;
      const cp = plan!.chapters[this.doneChapters];
      const chapter = this.state.chapters[this.doneChapters];

      // 开局前问题（第 0 章）
      if (this.doneChapters === 0 && !chapter) {
        const un = this.unansweredQuestions(0, plan!.questions);
        if (un.length) {
          this.status = 'questions';
          this.pending = { kind: 'questions', chapter: 0, questions: un };
          return this.snapshot();
        }
      }

      // 进入新章节：先问本章问题（已答/已跳过的跳过）
      if (!chapter) {
        const un = this.unansweredQuestions(chOrder, cp.questions);
        if (un.length) {
          this.status = 'questions';
          this.pending = { kind: 'questions', chapter: chOrder, questions: un };
          return this.snapshot();
        }
        this.state.chapters.push({ order: chOrder, title: cp.title || '第 ' + chOrder + ' 章', segments: [] });
        this.reviewProgress = null;
        this.persist();
        this.logEntry('info', '开始第 ' + chOrder + ' 章「' + (cp.title || '') + '」');
        emit?.({ type: 'log', text: '开始第 ' + chOrder + ' 章「' + (cp.title || '') + '」' });
        continue;
      }

      // 写段落：按段号补齐（定向重写后中间段落可能缺失）
      const missingOrder = this.nextMissingOrder(chapter, cp.segments);
      if (missingOrder !== null) {
        const segOrder = missingOrder;
        emit?.({ type: 'segment', chapter: chOrder, segOrder, title: chapter.title || '', goal: cp.goal || '' });
        const text = await this.writeOneSegment(cp, chOrder, chapter, segOrder, emit);
        if (this.mode() === 'segment') {
          this.status = 'segment';
          this.pending = { kind: 'segment', chapter: chOrder, segOrder, text };
          return this.snapshot();
        }
        // 自动 / 逐章：直接采纳
        this.pushSegment(chapter, segOrder, text);
        this.persist();
        continue;
      }

      // 审查（审查报告始终呈现给作者判断）
      const review = await this.runReviewPoints(cp, chOrder, chapter, emit);
      if (review.pending) {
        this.status = 'review';
        this.pending = review.pending;
        return this.snapshot();
      }
      if (review.redo) {
        await this.performRewrite(chOrder, chapter, review.report ?? null);
        this.reviewProgress = null;
        this.persist(true);
        continue;
      }
      this.fixDirective = '';
      this.rewritePlan = null;
      this.persist();

      // 整章确认（逐章模式）：批准后由 decide 推进到下一章
      if (this.mode() === 'chapter') {
        this.status = 'chapter';
        this.pending = {
          kind: 'chapter',
          chapter: chOrder,
          title: chapter.title,
          text: chapter.segments.map((s) => s.text).join('\n\n'),
        };
        return this.snapshot();
      }

      // 本章完成（自动 / 逐段模式），等待作者决定是否继续
      this.status = 'chapter_done';
      this.pending = { kind: 'chapter_done', chapter: chOrder };
      return this.snapshot();
    }
  }

  // ---------------- 决策入口 ----------------

  async answerQuestions(answers: { question: string; answer: string }[]): Promise<SessionSnapshot> {
    if (!this.pending || this.pending.kind !== 'questions') return this.snapshot();
    const chapter = this.pending.chapter;
    let saved = 0;
    for (const a of answers) {
      const q = String(a.question ?? '').trim();
      const ans = String(a.answer ?? '').trim();
      if (!q || !ans) continue;
      const exists = this.state.authorNotes.some((n) => n.question === q && n.answer === ans);
      if (exists) continue;
      this.state.authorNotes.push({ chapter, question: q, answer: ans, ts: nowIso() });
      saved++;
    }
    if (saved > 0) {
      this.persist();
      this.logEntry('note', '记下 ' + saved + ' 条作者答复（视为设定，后续创作持续生效）');
    }
    for (const q of this.pending.questions) this.dismissed.add(this.qKey(chapter, q));
    this.pending = null;
    this.status = 'writing';
    this.persist();
    return this.snapshot();
  }

  /** 处理待决事项：for = 待决类型，action = 决策动作 */
  async decide(
    forKind: 'segment' | 'chapter' | 'review' | 'chapter_done',
    action: string,
    payload: { editedText?: string; strictness?: ReviewStrictness; mode?: ApprovalMode } = {}
  ): Promise<SessionSnapshot> {
    if (this.status === 'stopped' || this.status === 'finished') return this.snapshot();
    const pending = this.pending;
    if (!pending || pending.kind !== forKind) return this.snapshot();

    if (forKind === 'segment' && pending.kind === 'segment') {
      const chapter = this.state.chapters[this.state.chapters.length - 1];
      if (action === 'approve') {
        this.pushSegment(chapter, pending.segOrder, pending.text);
        this.persist();
        this.pending = null;
        this.status = 'writing';
        return this.snapshot();
      }
      if (action === 'edit') {
        const edited = (payload.editedText ?? '').trim();
        if (!edited) return this.snapshot();
        this.pushSegment(chapter, pending.segOrder, edited, pending.text);
        this.persist();
        this.pending = null;
        this.status = 'writing';
        return this.snapshot();
      }
      if (action === 'redo') {
        // 重写本段：丢弃当前草稿，交由流式创作重新生成
        this.pending = null;
        this.status = 'writing';
        this.logEntry('info', '重新生成第 ' + pending.chapter + ' 章第 ' + pending.segOrder + ' 段…');
        return this.snapshot();
      }
      if (action === 'back') {
        // 打回：移除上一段已采纳的段落，当前段重新生成
        if (chapter.segments.length > 0) chapter.segments.pop();
        this.persist(true);
        this.pending = null;
        this.status = 'writing';
        this.logEntry('info', '打回上一段，重新生成第 ' + pending.chapter + ' 章第 ' + pending.segOrder + ' 段');
        return this.snapshot();
      }
      if (action === 'stop') {
        this.stop();
        return this.snapshot();
      }
      if (action === 'mode') {
        // switchMode 已处理「逐段待审切到非逐段」的采纳；其余情况保留当前段等待处理
        await this.switchMode(payload.mode ?? 'auto');
        return this.snapshot();
      }
      return this.snapshot();
    }

    if (forKind === 'chapter' && pending.kind === 'chapter') {
      if (action === 'approve') {
        this.pending = null;
        // 逐章模式：批准即完成本章，推进到下一章（否则下一次推进会重复确认同一章，页面无限闪动）
        this.doneChapters = Math.min(planChapters(this.state), this.doneChapters + 1);
        this.logEntry('info', '第 ' + pending.chapter + ' 章已批准');
        this.status = 'writing';
        return this.snapshot();
      }
      if (action === 'redo') {
        const ch = this.state.chapters[this.state.chapters.length - 1];
        await this.performRewrite(pending.chapter, ch, null);
        this.reviewProgress = null;
        this.pending = null;
        this.status = 'writing';
        this.persist(true);
        return this.snapshot();
      }
      if (action === 'stop') {
        this.stop();
        return this.snapshot();
      }
      if (action === 'mode') {
        await this.switchMode(payload.mode ?? 'auto');
        return this.snapshot();
      }
      return this.snapshot();
    }

    if (forKind === 'review' && pending.kind === 'review') {
      if (action === 'ignore') {
        this.pending = null;
        this.status = 'writing';
        this.persist(); // 审查报告已记录：立即落盘（含 reviews.md）
        return this.snapshot();
      }
      if (action === 'strictness') {
        const next = normalizeStrictness(payload.strictness);
        this.state.reviewStrictness = next;
        this.persist();
        this.logEntry('mode', '下次审查力度调整为：' + STRICTNESS_LABEL[next].split('：')[0]);
        // 保持当前报告，等待作者重新决策
        return this.snapshot();
      }
      if (action === 'redo') {
        const ch = this.state.chapters[this.state.chapters.length - 1];
        await this.performRewrite(pending.chapter, ch, pending.report);
        this.reviewProgress = null;
        this.pending = null;
        this.status = 'writing';
        this.persist(true);
        return this.snapshot();
      }
      return this.snapshot();
    }

    if (forKind === 'chapter_done' && pending.kind === 'chapter_done') {
      if (action === 'continue') {
        this.pending = null;
        this.doneChapters = Math.min(planChapters(this.state), this.doneChapters + 1);
        this.status = 'writing';
        return this.snapshot();
      }
      if (action === 'stop') {
        this.stop();
        return this.snapshot();
      }
      if (action === 'mode') {
        await this.switchMode(payload.mode ?? 'auto');
        return this.snapshot();
      }
      return this.snapshot();
    }

    return this.snapshot();
  }

  /** 创作中切换审批模式（本作品与全局默认同步） */
  async switchMode(mode: ApprovalMode): Promise<SessionSnapshot> {
    const m = mode === 'segment' || mode === 'chapter' ? mode : 'auto';
    if (m !== this.mode()) {
      setApprovalMode(this.cfg, m);
      this.state.approvalMode = m;
      this.persist();
      this.logEntry('mode', '审批模式切换为「' + (m === 'auto' ? '自动' : m === 'segment' ? '逐段' : '逐章') + '」（本作品与全局默认同步）');
    }
    // 逐段待审时切到非逐段：直接采纳当前段，由前端流式继续
    if (this.pending && this.pending.kind === 'segment' && this.mode() !== 'segment') {
      const p = this.pending;
      const chapter = this.state.chapters[this.state.chapters.length - 1];
      this.pushSegment(chapter, p.segOrder, p.text);
      this.persist();
      this.pending = null;
      this.status = 'writing';
    }
    return this.snapshot();
  }

  /** 停止本轮创作 */
  stop(): SessionSnapshot {
    if (this.status !== 'finished') {
      this.status = 'stopped';
      this.pending = null;
      this.logEntry('info', '本轮创作已停止（作品已保存，可随时继续）');
    }
    return this.snapshot();
  }

  // ---------------- 内部实现 ----------------

  private unansweredQuestions(chapter: number, questions: string[]): string[] {
    return questions.filter(
      (q) =>
        !this.dismissed.has(this.qKey(chapter, q)) &&
        !this.state.authorNotes.some((n) => n.chapter === chapter && n.question === q && n.answer)
    );
  }

  private qKey(chapter: number, q: string): string {
    return chapter + '|' + q;
  }

  private pushSegment(chapter: Chapter, segOrder: number, text: string, original?: string): void {
    const seg: ChapterSegment = { order: segOrder, text, userEdited: Boolean(original), original: original || undefined };
    const idx = chapter.segments.findIndex((x) => x.order === segOrder);
    if (idx >= 0) chapter.segments[idx] = seg;
    else {
      chapter.segments.push(seg);
      chapter.segments.sort((a, b) => a.order - b.order);
    }
    if (original && original !== text) {
      recordFeedback({
        id: newId('fb'),
        novelId: this.state.id,
        chapter: chapter.order,
        segment: segOrder,
        original,
        edited: text,
        ts: nowIso(),
      });
      this.logEntry('feedback', '已记录你对第 ' + chapter.order + ' 章第 ' + segOrder + ' 段的修改（可用于反馈学习）');
    }
    this.logEntry('segment', '第 ' + chapter.order + ' 章第 ' + segOrder + ' 段完成（' + text.length + ' 字）');
  }

  private async buildInput(cp: ChapterPlan | null, chOrder: number, chapter: Chapter, segOrder: number): Promise<WriteSegmentInput> {
    const allSettings = this.service.listSettings();
    const allStyles = this.service.listStyles();
    const usedSettings = allSettings.filter((s) => this.state.selectedSettingIds.includes(s.id));
    const usedStyles = allStyles.filter((s) => this.state.selectedStyleIds.includes(s.id));
    const settingPool = usedSettings.length ? usedSettings : allSettings;
    const stylePool = usedStyles.length ? usedStyles : allStyles;
    const chTitle = cp?.title || chapter.title || '第 ' + chOrder + ' 章';
    const recent = this.recentText(chOrder);
    const query = [this.state.requirement, chTitle, cp?.goal ?? '', recent.slice(-300)].join(' ');
    const sources: IndexSources = { settings: settingPool, styles: stylePool, chapters: this.state.chapters, notes: this.state.authorNotes };
    const retrieved = this.cfg.rag.enabled ? buildRagContext(query, sources, this.cfg.rag, this.ragChapterCache) : emptyRetrieval();
    const context = renderContext(retrieved, recent);
    const nextBeat = cp?.beats[segOrder - 1] ?? '';
    return {
      requirement: this.state.requirement,
      context,
      chapterGoal: chTitle + '：' + (cp?.goal ?? ''),
      nextBeat,
      fixDirective: this.segmentFixDirective(segOrder),
    };
  }

  private async writeOneSegment(cp: ChapterPlan, chOrder: number, chapter: Chapter, segOrder: number, emit?: (ev: SessionStreamEvent) => void): Promise<string> {
    const input = await this.buildInput(cp, chOrder, chapter, segOrder);
    try {
      return await writeSegment(this.llm, input, 0.85, (delta) => emit?.({ type: 'text', delta }), this.cfg.writerSystemPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logEntry('error', '生成失败：' + msg);
      throw e;
    }
  }

  private recentText(chapterOrder: number): string {
    const out: string[] = [];
    for (const ch of this.state.chapters) {
      if (ch.order > chapterOrder) break;
      for (const seg of ch.segments) out.push(seg.text);
    }
    return out.join('\n\n');
  }

  /** 审查入口：规划指定章节审查 + 每 N 章宏观一致性检查 */
  private async runReviewPoints(
    cp: ChapterPlan,
    chOrder: number,
    chapter: Chapter,
    emit?: (ev: SessionStreamEvent) => void
  ): Promise<{ redo: boolean; fixDirective: string; report?: ReviewReport; auto?: boolean; pending?: PendingDecision }> {
    const doChapterReview = Boolean(cp.reviewAfter);
    const doMacro = chOrder % this.cfg.macroCheckInterval === 0;
    if (!doChapterReview && !doMacro) return { redo: false, fixDirective: '' };

    const settings = this.service.listSettings();
    const chapterText = chapter.segments.map((s) => s.text).join('\n\n');
    const settingsSummary = settingsSummaryByRelevance(settings, chapterText + '\n' + cp.goal, 12);
    const styleRules = this.service
      .listStyles()
      .filter((s) => this.state.selectedStyleIds.includes(s.id))
      .flatMap((s) => s.rules);
    const focus = (this.state.reviewFocus ?? '').trim() || (this.cfg.reviewFocus ?? '').trim();
    const strictness = normalizeStrictness(this.state.reviewStrictness ?? this.cfg.reviewStrictness);
    // 非自动模式：审查报告始终呈现给作者判断；自动模式：规则层裁决（decideReviewAction），总规划只在计划级问题/反复返工时介入
    const autoMode = this.mode() === 'auto';
    const prog = this.reviewProgress ?? { chapter: chOrder, chapterDone: false, macroDone: false };

    if (doChapterReview && !prog.chapterDone) {
      emit?.({ type: 'log', text: '正在章节审查（第 ' + chOrder + ' 章）…' });
      const report = await reviewChapter(this.llm, {
        text: chapterText,
        goal: cp.goal,
        settingsSummary,
        styleRules,
        scope: '本章',
        focus,
        strictness,
      });
      this.recordReview('chapter', chOrder, report);
      this.logEntry('review', '章节审查完成（第 ' + chOrder + ' 章 · 总分 ' + report.score.overall + (report.passed ? ' · 通过' : ' · 未通过') + '）');
      emit?.({ type: 'review', text: '章节审查完成：' + (report.passed ? '通过' : '未通过') + '（总分 ' + report.score.overall + '）' });
      prog.chapterDone = true;
      this.reviewProgress = prog;
      if (!autoMode) {
        return { redo: false, fixDirective: '', pending: { kind: 'review', reviewKind: 'chapter', chapter: chOrder, report } };
      }
      // 自动模式：规则层裁决（0 次额外 LLM 调用）；自动重写最多 AUTO_REWRITE_MAX 次，避免死循环
      const decision = decideReviewAction(report);
      if (decision !== 'ignore') {
        const rewrites = this.autoRewrites.get(chOrder) ?? 0;
        if (rewrites >= AUTO_REWRITE_MAX) {
          this.logEntry('info', '自动模式：第 ' + chOrder + ' 章已自动重写 ' + rewrites + ' 次仍未通过，保留当前版本继续（可随时手动重写）');
        } else {
          this.autoRewrites.set(chOrder, rewrites + 1);
          return { redo: true, fixDirective: '', report, auto: true };
        }
      }
    }

    if (doMacro && !prog.macroDone) {
      emit?.({ type: 'log', text: '正在宏观一致性检查（第 ' + chOrder + ' 章）…' });
      const report = await macroCheck(this.llm, {
        text: buildMacroCheckText(this.state.chapters),
        goal: this.state.requirement,
        settingsSummary,
        styleRules,
        scope: '全书（宏观一致性）',
        focus,
        strictness,
      });
      this.recordReview('macro', chOrder, report);
      this.logEntry('review', '宏观一致性检查完成（第 ' + chOrder + ' 章 · 总分 ' + report.score.overall + (report.passed ? ' · 通过' : ' · 未通过') + '）');
      emit?.({ type: 'review', text: '宏观一致性检查完成：' + (report.passed ? '通过' : '未通过') + '（总分 ' + report.score.overall + '）' });
      prog.macroDone = true;
      this.reviewProgress = prog;
      if (!autoMode) {
        return { redo: false, fixDirective: '', pending: { kind: 'review', reviewKind: 'macro', chapter: chOrder, report } };
      }
      // 自动模式：宏观不过 → P1a 总规划 Agent 修订创作计划（每作品最多 PLAN_REVISE_MAX 次），正文不重写
      if (!report.passed && this.planRevises < PLAN_REVISE_MAX) {
        const chaptersSummary = this.state.chapters.map((c) => '第 ' + c.order + ' 章 ' + c.title).join('；') + '（已写 ' + this.state.chapters.length + ' 章）';
        const revised = await revisePlan(this.llm, {
          requirement: this.state.requirement,
          plan: this.state.plan ?? { premise: '', strategy: '', styleDirectives: [], questions: [], reviewSchedule: '', chapters: [] },
          report,
          chaptersSummary,
        });
        if (revised) {
          this.state.plan = revised;
          this.planDirty = true;
          this.planRevises++;
          this.logEntry('plan', '宏观检查发现计划级问题，总规划 Agent 已修订创作计划');
          emit?.({ type: 'log', text: '宏观检查发现计划级问题，总规划 Agent 已修订创作计划' });
        }
      }
    }

    return { redo: false, fixDirective: '' };
  }

  private recordReview(kind: 'chapter' | 'macro', chapter: number, report: ReviewReport): void {
    this.reviewsDirty = true;
    this.state.reviews.push({
      id: newId('rev'),
      kind,
      chapter,
      passed: report.passed,
      score: report.score,
      issues: report.issues,
      strengths: report.strengths,
      suggestions: report.suggestions,
      ts: nowIso(),
    });
  }

  /**
   * 执行重写（GUI/CLI 共用的统一入口）：
   * - 优先定向重写：只删除重写方案指定的段落（或审查报告 targetSegments），其余保留；
   * - 无定向目标则整章重写（pop 章节，重新生成全部段落）；
   * - P1b：同一章重写 ≥ REWRITE_DIAGNOSE_MIN 次时，先由总规划 Agent 诊断，再生成重写方案。
   */
  private async performRewrite(chOrder: number, chapter: Chapter | undefined, report: ReviewReport | null): Promise<void> {
    const cp = this.state.plan?.chapters[this.doneChapters];
    const chapterText = chapter ? chapter.segments.map((seg) => seg.text).join('\n\n') : '';
    const count = (this.rewriteCounts.get(chOrder) ?? 0) + 1;
    this.rewriteCounts.set(chOrder, count);
    let diagnosis: string | null = null;
    if (report && count >= REWRITE_DIAGNOSE_MIN) {
      diagnosis = await diagnoseRewrite(this.llm, {
        requirement: this.state.requirement,
        chapterTitle: chapter?.title ?? '',
        chapterGoal: cp?.goal ?? '',
        chapterText,
        report,
        pastDirectives: this.fixDirective ? [this.fixDirective] : [],
      });
    }
    if (diagnosis) this.logEntry('plan', '总规划 Agent 诊断：' + (diagnosis.length > 120 ? diagnosis.slice(0, 120) + '…' : diagnosis));
    this.rewritePlan = report
      ? await planChapterRewrite(this.llm, {
          requirement: this.state.requirement,
          chapterTitle: chapter?.title ?? '',
          chapterGoal: cp?.goal ?? '',
          chapterText,
          report,
          diagnosis: diagnosis ?? undefined,
        })
      : null;
    this.fixDirective = report ? buildRewriteDirective(report) : '';
    if (!chapter) return;
    // 定向重写：优先用重写方案指定的段；其次审查报告 targetSegments；都没有则整章
    const targets = this.rewritePlan && this.rewritePlan.segments.length
      ? this.rewritePlan.segments.map((x) => x.order)
      : report?.action === 'patch'
        ? (report.targetSegments ?? [])
        : [];
    if (targets.length) {
      chapter.segments = chapter.segments.filter((x) => !targets.includes(x.order));
      this.logEntry('info', (this.mode() === 'auto' ? '自动' : '按审查意见') + '定向重写第 ' + chOrder + ' 章（仅第 ' + targets.join('、') + ' 段）…');
    } else {
      this.state.chapters.pop();
      this.logEntry('info', (this.mode() === 'auto' ? '自动' : '按审查意见') + '重写第 ' + chOrder + ' 章…');
    }
  }

  /** 下一个缺失的段号（定向重写后中间段可能被删，按序补齐）；全部写完返回 null */
  private nextMissingOrder(chapter: Chapter, total: number): number | null {
    const existing = new Set(chapter.segments.map((x) => x.order));
    for (let o = 1; o <= total; o++) if (!existing.has(o)) return o;
    return null;
  }

  /** 当前段要携带的重写指令：有整章方案时取「方案 + 本段要点」，否则回落全局 fixDirective */
  private segmentFixDirective(segOrder: number): string {
    if (this.rewritePlan) {
      const parts = ['【本章重写方案】' + this.rewritePlan.approach];
      const seg = this.rewritePlan.segments.find((x) => x.order === segOrder);
      if (seg) parts.push('【本段修改要点】' + seg.fix);
      return parts.join('\n');
    }
    return this.fixDirective;
  }

  private logEntry(type: SessionLogEntry['type'], text: string): void {
    this.log.push({ ts: nowIso(), type, text });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  // ---------------- 快照 ----------------

  snapshot(): SessionSnapshot {
    const provider = getActiveProvider(this.cfg);
    return {
      novelId: this.state.id,
      title: this.state.title,
      requirement: this.state.requirement,
      status: this.status,
      approvalMode: this.state.approvalMode ?? this.cfg.approvalMode,
      provider: { name: provider.name, model: provider.model, isDemo: this.llm.isDemo },
      plan: this.state.plan,
      chapters: this.state.chapters,
      reviews: this.state.reviews,
      authorNotes: this.state.authorNotes,
      pending: this.pending,
      fixDirective: this.fixDirective,
      log: [...this.log],
      allDone: this.status === 'finished' || (Boolean(this.state.plan) && this.doneChapters >= (this.state.plan?.chapters.length ?? 0)),
      feedbackPending: listUnprocessedFeedback().length,
      strictness: normalizeStrictness(this.state.reviewStrictness ?? this.cfg.reviewStrictness),
    };
  }
}

/** 自动模式下每章最多自动重写的次数（达到后保留当前版本继续，防死循环） */
const AUTO_REWRITE_MAX = 1;
/** 同一章重写达到该次数后，下一次重写前由总规划 Agent 诊断（P1b） */
const REWRITE_DIAGNOSE_MIN = 2;
/** 自动模式下每作品最多进行的计划级修订次数（P1a） */
const PLAN_REVISE_MAX = 1;

function planChapters(state: NovelState): number {
  return state.plan?.chapters.length ?? 0;
}
