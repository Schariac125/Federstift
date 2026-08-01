/** 终端样式工具：参考主流 Agent CLI 的视觉习惯（符号 + 颜色 + 紧凑布局）。
 * 非 TTY / 管道输出时自动禁用颜色，保证日志可读。 */
export const hasColor: boolean =
  typeof process !== 'undefined' &&
  Boolean(process.stdout?.isTTY) &&
  process.env?.TERM !== 'dumb' &&
  !process.env?.NO_COLOR;

function wrap(code: string, text: string): string {
  return hasColor ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
}

export const paint = {
  cyan: (t: string) => wrap('36', t),
  green: (t: string) => wrap('32', t),
  yellow: (t: string) => wrap('33', t),
  red: (t: string) => wrap('31', t),
  dim: (t: string) => wrap('2', t),
  bold: (t: string) => wrap('1', t),
};

/** 语义输出 */
export function ok(msg: string): void {
  console.log(paint.green('✔ ') + msg);
}
export function warn(msg: string): void {
  console.log(paint.yellow('⚠ ') + msg);
}
export function err(msg: string): void {
  console.log(paint.red('✘ ') + msg);
}
export function info(msg: string): void {
  console.log(paint.cyan('· ') + msg);
}
export function muted(msg: string): void {
  console.log(paint.dim(msg));
}
export function heading(title: string): void {
  console.log('\n' + paint.cyan('━━━ ' + title + ' ' + '━'.repeat(Math.max(0, 40 - title.length))) + '\n');
}
/** 按显示宽度补齐到 width 列（中文/全角字符按 2 列计），用于对齐边框 */
export function padCn(s: string, width: number): string {
  const len = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - len));
}

export function rule(): void {
  console.log(paint.dim('─'.repeat(46)));
}
