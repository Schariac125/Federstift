/**
 * GUI 本地服务：node:http 零依赖 HTTP 服务。
 * 提供 JSON API（创作会话 / 知识库 / 设置 / 反馈学习）与静态前端页面。
 * 数据始终落在本地 workspace，不对外网开放（默认只监听 127.0.0.1）。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { appRoot, workspaceDir } from '../core/storage';
import { loadConfig, saveConfig, getActiveProvider, setProviderApiKey, setProviderModel, setCustomProvider, setApprovalMode, setReviewFocus, setReviewStrictness } from '../core/config';
import type { AppConfig } from '../core/config';
import { createKbService } from '../kb/service';
import { newStyle, newSetting, newTemplate } from '../kb/service';
import type { KbService } from '../kb/service';
import { analyzeExample, analyzeStyleWithLLM } from '../kb/createStyle';
import { extractSettings } from '../kb/extract';
import { createLLM } from '../core/llm';
import { listNovels, loadNovel, deleteNovel } from '../pipeline/novel';
import { GuiSession } from './session';
import type { CreateNovelOptions, SessionStreamEvent } from './session';
import { listFeedbackRecords, listUnprocessedFeedback, analyzeFeedbackRuleBased, analyzeFeedbackWithLLM, mergeCandidates, applyPreferencesToStyle, markFeedbackProcessed, deleteFeedbackForNovel } from '../learning/feedback';
import type { PreferenceCandidate } from '../learning/feedback';
import { SETTING_CATEGORIES, categoryLabel } from '../kb/types';
import { logger } from '../core/logger';

export const VERSION = '0.10.0';

export interface GuiServerHandle {
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface GuiServerOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
}

function publicDir(): string {
  return path.join(appRoot(), 'gui', 'public');
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** SSE 流式推进：把 GuiSession.advance 的流式事件实时推送给浏览器 */
async function streamSession(req: http.IncomingMessage, res: http.ServerResponse, session: GuiSession): Promise<void> {
  if (session.busy) {
    json(res, 409, { error: '已有创作任务进行中，请稍候再试' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const send = (ev: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // 流式正文增量合并：30ms 窗口内的 text delta 合并为一条 SSE 事件，减少事件数与浏览器端解析/渲染频率
  let deltaBuffer = '';
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDeltas = (): void => {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
    }
    if (deltaBuffer) {
      send('text', { type: 'text', delta: deltaBuffer });
      deltaBuffer = '';
    }
  };
  const emitEvent = (ev: SessionStreamEvent): void => {
    if (ev.type === 'text') {
      deltaBuffer += ev.delta;
      if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 30);
      return;
    }
    flushDeltas();
    send(ev.type, ev);
  };
  try {
    const snapshot = await session.advance((ev) => emitEvent(ev));
    flushDeltas();
    send('done', { snapshot });
  } catch (e) {
    flushDeltas();
    send('error', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (deltaTimer) clearTimeout(deltaTimer);
    if (!res.writableEnded) res.end();
  }
}

function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 配置输出给前端时隐藏 API Key */
function publicConfig(cfg: AppConfig) {
  return {
    version: cfg.version,
    activeProviderId: cfg.activeProviderId,
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      hasKey: Boolean(p.apiKey),
      builtin: Boolean(p.builtin),
    })),
    approvalMode: cfg.approvalMode,
    macroCheckInterval: cfg.macroCheckInterval,
    reviewFocus: cfg.reviewFocus,
    reviewStrictness: cfg.reviewStrictness,
    plannerSystemPrompt: cfg.plannerSystemPrompt ?? '',
    writerSystemPrompt: cfg.writerSystemPrompt ?? '',
    rag: cfg.rag,
    firstRunDone: cfg.firstRunDone,
    workspace: workspaceDir(),
  };
}

/** 按作品 id 取会话（会话在服务进程内保持；服务重启后由前端重新建立） */
function sessionKey(id: string): string {
  return 'novel:' + id;
}

export async function startGuiServer(opts: GuiServerOptions = {}): Promise<GuiServerHandle> {
  const cfg = loadConfig();
  const service = createKbService();
  const sessions = new Map<string, GuiSession>();

  const host = opts.host ?? '127.0.0.1';
  const basePort = opts.port ?? (Number(process.env.FEDERSTIFT_PORT) || 3377);

  const getSession = async (id: string): Promise<GuiSession | null> => {
    const existing = sessions.get(sessionKey(id));
    if (existing) return existing;
    const novel = loadNovel(id);
    if (!novel) return null;
    const session = new GuiSession(loadConfig(), service, novel);
    sessions.set(sessionKey(id), session);
    return session;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://' + host);
      const p = url.pathname;
      const m = req.method ?? 'GET';

      // ---- 静态页面 ----
      if (m === 'GET' && (p === '/' || p === '/index.html')) {
        const file = path.join(publicDir(), 'index.html');
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(fs.readFileSync(file));
        } else {
          json(res, 500, { error: '未找到前端页面：gui/public/index.html（请确认项目文件完整）' });
        }
        return;
      }
      if (m === 'GET' && p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ---- API ----
      if (p.startsWith('/api/')) {
        // URL 中的中文/特殊字符 id 是百分号编码的，解码后才能匹配作品文件夹名
        const seg = p
          .replace(/^\/api\//, '')
          .split('/')
          .filter(Boolean)
          .map((s) => {
            try {
              return decodeURIComponent(s).replace(/[\\/]/g, '_');
            } catch {
              return s;
            }
          });

        if (m === 'GET' && seg[0] === 'health') {
          json(res, 200, { ok: true, version: VERSION, workspace: workspaceDir() });
          return;
        }

        if (m === 'GET' && seg[0] === 'state') {
          const stats = service.stats();
          json(res, 200, {
            config: publicConfig(cfg),
            kb: stats,
            novels: listNovels().map((n) => ({
              id: n.id,
              title: n.title,
              requirement: n.requirement,
              chapters: n.chapters.length,
              segments: n.chapters.reduce((a, c) => a + c.segments.length, 0),
              planChapters: n.plan?.chapters.length ?? n.planTarget ?? 0,
              planDone: Boolean(n.plan),
              reviews: n.reviews.length,
              updatedAt: n.updatedAt,
            })),
            feedbackPending: listUnprocessedFeedback().length,
          });
          return;
        }

        // ---- 新建作品 ----
        if (m === 'POST' && seg[0] === 'novel' && seg.length === 1) {
          const body = (await readBody(req)) as CreateNovelOptions;
          if (!body?.requirement?.trim()) {
            json(res, 400, { error: '创作要求不能为空' });
            return;
          }
          const session = await GuiSession.create(cfg, service, body);
          sessions.set(sessionKey(session.state.id), session);
          json(res, 200, { snapshot: session.snapshot() });
          return;
        }

        // ---- 作品详情 ----
        if (m === 'GET' && seg[0] === 'novel' && seg.length === 2) {
          const novel = loadNovel(seg[1]);
          if (!novel) {
            json(res, 404, { error: '作品不存在：' + seg[1] });
            return;
          }
          json(res, 200, { novel });
          return;
        }

        // ---- 删除作品 ----
        if (m === 'DELETE' && seg[0] === 'novel' && seg.length === 2) {
          const id = seg[1];
          if (!deleteNovel(id)) {
            json(res, 404, { error: '作品不存在：' + id });
            return;
          }
          sessions.delete(sessionKey(id));
          deleteFeedbackForNovel(id);
          json(res, 200, { ok: true });
          return;
        }

        // ---- 会话 ----
        if (seg[0] === 'session' && seg.length >= 2) {
          const id = seg[1];
          const session = await getSession(id);
          if (!session) {
            json(res, 404, { error: '作品不存在或无法打开：' + id });
            return;
          }
          if (m === 'GET' && seg.length === 2) {
            json(res, 200, { snapshot: session.snapshot() });
            return;
          }
          const action = seg[2];
          if (m === 'POST' && action === 'answer' && seg.length === 3) {
            const body = (await readBody(req)) as { answers?: { question: string; answer: string }[] };
            const snapshot = await session.answerQuestions(body?.answers ?? []);
            json(res, 200, { snapshot });
            return;
          }
          if (m === 'POST' && action === 'advance' && seg.length === 3) {
            const snapshot = await session.advance();
            json(res, 200, { snapshot });
            return;
          }
          if (m === 'POST' && action === 'stream' && seg.length === 3) {
            await streamSession(req, res, session);
            return;
          }
          if (m === 'POST' && action === 'decide' && seg.length === 3) {
            const body = (await readBody(req)) as { for?: string; action?: string; editedText?: string; strictness?: string; mode?: string };
            const snapshot = await session.decide(
              (body?.for ?? '') as 'segment' | 'chapter' | 'review' | 'chapter_done',
              body?.action ?? '',
              { editedText: body?.editedText, strictness: body?.strictness as never, mode: body?.mode as never }
            );
            json(res, 200, { snapshot });
            return;
          }
          if (m === 'POST' && action === 'mode' && seg.length === 3) {
            const body = (await readBody(req)) as { mode?: string };
            const snapshot = await session.switchMode((body?.mode ?? 'auto') as never);
            json(res, 200, { snapshot });
            return;
          }
          if (m === 'POST' && action === 'strictness' && seg.length === 3) {
            const body = (await readBody(req)) as { strictness?: string };
            const s = body?.strictness === 'strict' || body?.strictness === 'lenient' ? body.strictness : 'standard';
            const snapshot = await session.setStrictness(s as never);
            json(res, 200, { snapshot });
            return;
          }
          if (m === 'POST' && action === 'stop' && seg.length === 3) {
            const snapshot = session.stop();
            json(res, 200, { snapshot });
            return;
          }
          json(res, 404, { error: '未知会话操作：' + action });
          return;
        }

        // ---- 知识库 ----
        if (seg[0] === 'kb') {
          const kind = seg[1];

          // 范例式创建风格
          if (m === 'POST' && kind === 'styles' && seg[2] === 'from-example') {
            const body = (await readBody(req)) as { name?: string; exampleText?: string; description?: string; tags?: string[]; useAi?: boolean };
            const name = body?.name?.trim();
            const exampleText = body?.exampleText?.trim();
            if (!name || !exampleText) {
              json(res, 400, { error: '风格名与范例文本不能为空' });
              return;
            }
            let analysis = analyzeExample(exampleText);
            let aiUsed = false;
            const provider = getActiveProvider(cfg);
            const llm = createLLM(provider);
            if (body?.useAi && !llm.isDemo) {
              const ai = await analyzeStyleWithLLM(llm, exampleText);
              if (ai) {
                analysis = ai;
                aiUsed = true;
              }
            }
            const style = newStyle({
              name,
              description: body?.description?.trim() || analysis.summary,
              rules: analysis.rules,
              exampleText,
              tags: body?.tags ?? [],
              source: 'example',
            });
            service.saveStyle(style);
            json(res, 200, { style, summary: analysis.summary, aiUsed });
            return;
          }

          // 对话式创建设定
          if (m === 'POST' && kind === 'settings' && seg[2] === 'from-conversation') {
            const body = (await readBody(req)) as { category?: string; name?: string; content?: string; keepFacts?: string[]; aliases?: string[]; tags?: string[] };
            const name = body?.name?.trim();
            const content = body?.content?.trim();
            if (!name || !content) {
              json(res, 400, { error: '设定名称与描述不能为空' });
              return;
            }
            const allFacts = splitFacts(content);
            const keep = Array.isArray(body?.keepFacts) && body!.keepFacts!.length ? body!.keepFacts! : allFacts;
            const category = SETTING_CATEGORIES.some((c) => c.value === body?.category) ? (body!.category as never) : 'other';
            const setting = newSetting({
              name,
              category,
              content,
              facts: keep,
              aliases: body?.aliases ?? [],
              tags: body?.tags ?? [],
              source: 'conversation',
            });
            service.saveSetting(setting);
            json(res, 200, { setting, candidates: allFacts });
            return;
          }

          // 事实候选（对话式创建设定的预览步骤）
          if (m === 'POST' && kind === 'settings' && seg[2] === 'facts') {
            const body = (await readBody(req)) as { content?: string };
            json(res, 200, { candidates: splitFacts(body?.content ?? '') });
            return;
          }

          // 自动提取设定候选
          if (m === 'POST' && kind === 'settings' && seg[2] === 'extract') {
            const body = (await readBody(req)) as { text?: string };
            json(res, 200, { candidates: extractSettings(body?.text ?? '') });
            return;
          }

          // 保存（styles/settings/templates）
          if (m === 'POST' && (kind === 'styles' || kind === 'settings' || kind === 'templates') && seg.length === 2) {
            const body = (await readBody(req)) as Record<string, unknown>;
            const id = String(body?.id ?? '');
            const now = new Date().toISOString();
            if (kind === 'styles') {
              const entry = newStyle({
                id: id || undefined,
                name: String(body?.name ?? ''),
                description: String(body?.description ?? ''),
                rules: Array.isArray(body?.rules) ? body.rules.map(String) : [],
                exampleText: String(body?.exampleText ?? ''),
                tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
                source: (body?.source as never) ?? 'manual',
                createdAt: (body?.createdAt as string) || now,
                updatedAt: now,
              });
              service.saveStyle(entry);
              json(res, 200, { entry });
              return;
            }
            if (kind === 'settings') {
              const entry = newSetting({
                id: id || undefined,
                name: String(body?.name ?? ''),
                category: (body?.category as never) ?? 'other',
                content: String(body?.content ?? ''),
                facts: Array.isArray(body?.facts) ? body.facts.map(String) : [],
                aliases: Array.isArray(body?.aliases) ? body.aliases.map(String) : [],
                tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
                source: (body?.source as never) ?? 'manual',
                createdAt: (body?.createdAt as string) || now,
                updatedAt: now,
              });
              service.saveSetting(entry);
              json(res, 200, { entry });
              return;
            }
            const entry = newTemplate({
              id: id || undefined,
              name: String(body?.name ?? ''),
              purpose: String(body?.purpose ?? ''),
              prompt: String(body?.prompt ?? ''),
              tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
              createdAt: (body?.createdAt as string) || now,
              updatedAt: now,
            });
            service.saveTemplate(entry);
            json(res, 200, { entry });
            return;
          }

          // 删除
          if (m === 'DELETE' && (kind === 'styles' || kind === 'settings' || kind === 'templates') && seg.length === 3) {
            const id = seg[2];
            if (kind === 'styles') service.removeStyle(id);
            else if (kind === 'settings') service.removeSetting(id);
            else service.removeTemplate(id);
            json(res, 200, { ok: true });
            return;
          }

          // 列表
          if (m === 'GET' && (kind === 'styles' || kind === 'settings' || kind === 'templates') && seg.length === 2) {
            const list =
              kind === 'styles' ? service.listStyles() : kind === 'settings' ? service.listSettings() : service.listTemplates();
            json(res, 200, { entries: list });
            return;
          }

          json(res, 404, { error: '未知知识库操作' });
          return;
        }

        // ---- 反馈学习 ----
        if (seg[0] === 'feedback') {
          if (m === 'GET' && seg.length === 1) {
            const records = listFeedbackRecords();
            json(res, 200, { records, unprocessed: listUnprocessedFeedback().length });
            return;
          }
          if (m === 'POST' && seg[1] === 'analyze') {
            const body = (await readBody(req)) as { useLlm?: boolean };
            const records = listUnprocessedFeedback();
            if (!records.length) {
              json(res, 200, { candidates: [], records: 0 });
              return;
            }
            const ruleCands: PreferenceCandidate[] = [];
            for (const r of records) ruleCands.push(...analyzeFeedbackRuleBased(r.original, r.edited));
            let candidates = mergeCandidates(ruleCands);
            const provider = getActiveProvider(cfg);
            const llm = createLLM(provider);
            if (body?.useLlm && !llm.isDemo) {
              const llmCands = await analyzeFeedbackWithLLM(llm, records);
              candidates = mergeCandidates([...candidates, ...llmCands]);
            }
            json(res, 200, { candidates, records: records.length });
            return;
          }
          if (m === 'POST' && seg[1] === 'apply') {
            const body = (await readBody(req)) as { indexes?: number[]; candidates?: PreferenceCandidate[]; targetStyleId?: string | null; newStyleName?: string };
            const records = listUnprocessedFeedback();
            if (!records.length) {
              json(res, 400, { error: '没有待学习的修改记录' });
              return;
            }
            // 前端回传选中的候选（analyze 的结果缓存在前端）
            const indexes = new Set(body?.indexes ?? []);
            const chosenSafe = (body?.candidates ?? []).filter((_, i) => indexes.has(i));
            if (!chosenSafe.length) {
              json(res, 400, { error: '未选择任何偏好' });
              return;
            }
            let applied;
            if (body?.targetStyleId) {
              applied = applyPreferencesToStyle(service, body.targetStyleId, chosenSafe);
            } else {
              applied = applyPreferencesToStyle(service, null, chosenSafe, body?.newStyleName || '从反馈中学习');
            }
            markFeedbackProcessed(records.map((r) => r.id));
            json(res, 200, { style: applied, appliedCount: chosenSafe.length, learned: records.length });
            return;
          }
          json(res, 404, { error: '未知反馈操作' });
          return;
        }

        // ---- 设置 ----
        if (seg[0] === 'config') {
          if (m === 'GET' && seg.length === 1) {
            json(res, 200, { config: publicConfig(cfg) });
            return;
          }
          if (m === 'POST' && seg[1] === 'provider') {
            const body = (await readBody(req)) as { providerId?: string; apiKey?: string; model?: string; baseUrl?: string };
            const providerId = body?.providerId ?? '';
            if (providerId === 'demo') {
              json(res, 200, { config: publicConfig(cfg) });
              return;
            }
            if (providerId === 'custom') {
              if (body?.baseUrl && body?.apiKey && body?.model) {
                setCustomProvider(cfg, body.baseUrl, body.apiKey, body.model);
              }
            } else if (cfg.providers.some((p) => p.id === providerId)) {
              if (body?.apiKey) setProviderApiKey(cfg, providerId, body.apiKey);
              if (body?.model) setProviderModel(cfg, providerId, body.model);
            }
            json(res, 200, { config: publicConfig(cfg) });
            return;
          }
          if (m === 'POST' && seg[1] === 'general') {
            const body = (await readBody(req)) as Record<string, unknown>;
            if (body?.approvalMode === 'auto' || body?.approvalMode === 'segment' || body?.approvalMode === 'chapter') {
              setApprovalMode(cfg, body.approvalMode as never);
            }
            const interval = Number(body?.macroCheckInterval);
            if (!Number.isNaN(interval) && interval >= 1 && interval <= 100) cfg.macroCheckInterval = Math.round(interval);
            if (typeof body?.reviewFocus === 'string') setReviewFocus(cfg, body.reviewFocus);
            if (body?.reviewStrictness === 'strict' || body?.reviewStrictness === 'standard' || body?.reviewStrictness === 'lenient') {
              setReviewStrictness(cfg, body.reviewStrictness as never);
            }
            if (typeof body?.plannerSystemPrompt === 'string') cfg.plannerSystemPrompt = body.plannerSystemPrompt.trim();
            if (typeof body?.writerSystemPrompt === 'string') cfg.writerSystemPrompt = body.writerSystemPrompt.trim();
            if (body?.rag && typeof body.rag === 'object') {
              const rag = body.rag as Record<string, unknown>;
              if (typeof rag.enabled === 'boolean') cfg.rag.enabled = rag.enabled;
              const topK = Number(rag.topK);
              if (!Number.isNaN(topK) && topK >= 1 && topK <= 20) cfg.rag.topK = Math.round(topK);
            }
            saveConfig(cfg);
            json(res, 200, { config: publicConfig(cfg) });
            return;
          }
          json(res, 404, { error: '未知设置操作' });
          return;
        }

        json(res, 404, { error: '未知接口：' + p });
        return;
      }

      json(res, 404, { error: '未知路径：' + p });
    } catch (e) {
      logger.error('GUI API 错误：' + (e instanceof Error ? e.stack || e.message : String(e)));
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const port = await listen(server, host, basePort);

  if (opts.openBrowser !== false) {
    openBrowser('http://' + host + ':' + port + '/');
  }

  const handle: GuiServerHandle = {
    server,
    port,
    url: 'http://' + host + ':' + port + '/',
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  return handle;
}

function listen(server: http.Server, host: string, basePort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && p < basePort + 20) {
          server.removeAllListeners('error');
          tryPort(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, host, () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : p);
      });
    };
    tryPort(basePort);
  });
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { shell: platform === 'win32', detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 无法自动打开时静默，页面仍可手动访问
  }
}

function splitFacts(content: string): string[] {
  return content
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 80);
}
