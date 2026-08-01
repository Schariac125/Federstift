import * as fs from 'node:fs';
import * as path from 'node:path';

/** 项目根目录（编译后：<root>/dist/core/storage.js） */
export function appRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/** 用户数据目录：项目下的 workspace；可用环境变量 FEDERSTIFT_WORKSPACE 覆盖（便于测试与便携） */
export function workspaceDir(): string {
  const override = process.env.FEDERSTIFT_WORKSPACE;
  const dir = override ? path.resolve(override) : path.join(appRoot(), 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 各知识库子目录 */
export function kbDir(kind: 'styles' | 'settings' | 'templates' | 'novels' | 'feedback'): string {
  const dir = path.join(workspaceDir(), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再改名，避免写一半损坏 */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 追加文本到文件（章节正文等），自动补换行 */
export function appendText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
}
