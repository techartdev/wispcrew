/**
 * cli-output.ts — two audiences, one binary.
 *
 * The single most important decision in a CLI that both people and programs
 * use. A human wants columns, colour and a sensible default when they omit an
 * argument. A program wants none of that: `✨ Thinking...` on stdout, a
 * spinner, or prose wrapped around JSON turns a parseable result into a
 * scraping problem.
 *
 * So every command produces a **value**, and this module decides how it
 * reaches the terminal. A command never calls `console.log` itself — that is
 * what keeps `--json` honest, rather than mostly honest.
 */

export type OutputMode = 'text' | 'json' | 'ndjson';

export interface OutputOptions {
  mode: OutputMode;
  /** Suppress everything except the result itself. */
  quiet: boolean;
  /** Never prompt; fail instead of waiting for input nobody will give. */
  interactive: boolean;
}

/**
 * Resolve output options from parsed flags.
 *
 * `--json` is a shorthand for `--output json` because it is what people
 * actually type, and both must mean the same thing.
 */
export function outputOptions(args: Record<string, string | boolean>): OutputOptions {
  const explicit = typeof args.output === 'string' ? args.output : undefined;
  const mode: OutputMode =
    args.json === true || explicit === 'json'
      ? 'json'
      : explicit === 'ndjson'
        ? 'ndjson'
        : 'text';

  return {
    mode,
    quiet: args.quiet === true,
    /*
     * Machine modes are never interactive.
     *
     * A prompt in a script is a hang: nothing is watching, and the caller
     * waits for a timeout instead of getting an error it could handle.
     */
    interactive: mode === 'text' && args['no-interactive'] !== true && process.stdin.isTTY === true,
  };
}

/** Something a command produced, and how a person should see it. */
export interface Rendered {
  /** The machine-readable value. Must be JSON-serialisable. */
  value: unknown;
  /** Lines for a person. Ignored in json and ndjson modes. */
  lines?: string[];
}

/**
 * Print a command's result.
 *
 * In `json` mode this writes exactly one object and nothing else — no
 * heading, no trailing note, no "done". That is the whole contract: a caller
 * can pipe stdout into a parser without filtering.
 */
export function emit(result: Rendered, opts: OutputOptions): void {
  if (opts.mode === 'json') {
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
    return;
  }

  if (opts.mode === 'ndjson') {
    // A list becomes one object per line, which is what makes streaming
    // useful; anything else is a single line.
    const items = Array.isArray(result.value) ? result.value : [result.value];
    for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }

  if (opts.quiet) return;
  for (const line of result.lines ?? []) console.log(line);
}

/**
 * One event in a stream, for `--output ndjson`.
 *
 * The engine already pushes events rather than being polled, so streaming a
 * turn is a transport change rather than a new mechanism.
 */
export function emitEvent(event: Record<string, unknown>, opts: OutputOptions): void {
  if (opts.mode === 'ndjson') {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

/**
 * Report a failure and choose an exit code.
 *
 * Errors go to **stderr** even in text mode, so `cmd --json > out.json`
 * leaves a parseable file and a readable complaint. In machine modes the
 * error is JSON too, because a caller that must parse success and scrape
 * failure has been given half a contract.
 */
export function fail(message: string, opts: OutputOptions, code = 1): never {
  if (opts.mode === 'text') {
    process.stderr.write(`${message}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  }
  process.exit(code);
}

/** Pad a column without pulling in a table library. */
export function column(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Format a list as aligned columns.
 *
 * Widths come from the content, so a long agent name does not wrap and a
 * short list does not leave a gutter. Deliberately plain: no borders, no
 * colour, because output that a person reads is also output somebody will
 * eventually `grep`.
 */
export function table(rows: string[][], headers?: string[]): string[] {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return [];

  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }

  const format = (row: string[]) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : column(cell, widths[i]!)))
      .join('  ')
      .trimEnd();

  return headers ? [format(headers), ...rows.map(format)] : rows.map(format);
}
