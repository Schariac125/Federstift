import * as fs from 'node:fs';
import * as path from 'node:path';
import { workspaceDir } from './storage';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private level: LogLevel = 'info';
  private filePath: string | null = null;

  init() {
    try {
      const logDir = path.join(workspaceDir(), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      this.filePath = path.join(logDir, `app-${stamp}.log`);
    } catch {
      this.filePath = null;
    }
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private write(level: LogLevel, msg: string) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = `[${new Date().toISOString()}][${level}] ${msg}`;
    if (level === 'warn' || level === 'error') console.error(line);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, line + '\n', 'utf8');
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  debug(msg: string) { this.write('debug', msg); }
  info(msg: string) { this.write('info', msg); }
  warn(msg: string) { this.write('warn', msg); }
  error(msg: string) { this.write('error', msg); }
}

export const logger = new Logger();
