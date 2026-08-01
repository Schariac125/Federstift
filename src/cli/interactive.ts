import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { paint, heading } from './ui';

let rl: readline.Interface | null = null;

export function getRl(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input, output, terminal: true });
    rl.on('close', () => process.exit(0));
  }
  return rl;
}

const PROMPT = paint.cyan('❯ ');

/** 单行输入；def 为默认值（直接回车使用） */
export async function ask(question: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? paint.dim('（回车 = ' + def + '）') : '';
  const answer = (await getRl().question(paint.bold(question) + suffix + ' ' + PROMPT)).trim();
  if (answer === '' && def !== undefined) return def;
  return answer;
}

export async function askConfirm(question: string, def: boolean): Promise<boolean> {
  const label = def ? paint.green('Y') + paint.dim('/n') : paint.dim('y/') + paint.green('N');
  const answer = (await getRl().question(paint.bold(question) + ' ' + label + ' ' + PROMPT)).trim().toLowerCase();
  if (answer === '') return def;
  return answer === 'y' || answer === 'yes' || answer === '是';
}

export interface ChoiceOption<T> {
  key: string;
  label: string;
  value: T;
}

export async function askChoice<T>(
  question: string,
  options: ChoiceOption<T>[],
  defKey?: string
): Promise<T> {
  heading(question);
  options.forEach((o, i) => {
    const isDef = o.key === defKey;
    const num = paint.cyan(String(i + 1).padStart(2, ' ') + '.');
    const marker = isDef ? '  ' + paint.green('（默认）') : '';
    console.log('  ' + num + ' ' + (isDef ? paint.bold(o.label) : o.label) + marker);
  });
  const answer = (await getRl().question(paint.dim('输入序号回车确认') + ' ' + PROMPT)).trim();
  if (answer === '' && defKey) {
    const def = options.find((o) => o.key === defKey);
    if (def) return def.value;
  }
  const idx = parseInt(answer, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
    return options[idx - 1].value;
  }
  const byKey = options.find((o) => o.key === answer.toLowerCase());
  if (byKey) return byKey.value;
  console.log(paint.yellow('输入无效，请重试。'));
  return askChoice(question, options, defKey);
}

/** 多行输入：输入单独一行 END（或 .end）结束 */
export async function askMultiline(question: string, hint = '输入 END 单独一行结束'): Promise<string> {
  console.log('\n' + paint.bold(question));
  console.log(paint.dim('（' + hint + '）'));
  const lines: string[] = [];
  while (true) {
    const line = await getRl().question(paint.dim('  > '));
    if (line.trim().toLowerCase() === 'end' || line.trim() === '.end') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

export async function pressEnter(): Promise<void> {
  await getRl().question(paint.dim('按回车继续...'));
}

export function closeRl(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

export function divider(title?: string): void {
  if (title) {
    console.log('\n' + paint.cyan('━━━ ' + title + ' ' + '━'.repeat(Math.max(0, 40 - title.length))));
  } else {
    console.log(paint.dim('─'.repeat(46)));
  }
}
