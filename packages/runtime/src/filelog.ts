/** Tiny file logger for debugging the sand protocol (no deps). */
import fs from 'node:fs';

let logPath: string | null = null;

export function initFileLog(): void {
  logPath = process.env.WISPCREW_LOG ?? null;
  if (logPath) {
    try {
      fs.writeFileSync(logPath, `--- wispcrew log ${new Date().toISOString()} ---\n`);
    } catch {
      logPath = null;
    }
  }
}

export function fileLog(...parts: unknown[]): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(
      logPath,
      parts
        .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
        .join(' ')
        .slice(0, 500) + '\n',
    );
  } catch {
    /* ignore */
  }
}
