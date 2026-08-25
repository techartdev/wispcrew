/**
 * shell-quoting-test.mjs — a command line reaches the shell as written.
 *
 * Reported as an agent that could not use an SSH key and concluded the
 * problem was the space in "C:\Users\Vanyo Vanev\.ssh". It started copying
 * the key elsewhere to work around something that was our bug, twice over:
 *
 *  1. Node escapes quotes with backslashes when building a Windows command
 *     line, and cmd.exe does not use backslash escaping. Commands arrived
 *     containing literal \" and failed with
 *     '\"C:\Program Files\...\"' is not recognized...
 *
 *  2. `cmd /s /c` strips the first and last character when both are quotes.
 *     A command *beginning* with a quoted path lost its opening quote and
 *     split at the first space: 'C:\Program' is not recognized...
 *
 * Both only appear on Windows, and only with quoted paths — which is most
 * real Windows commands.
 *
 * Offline: local processes only.
 */
import { shellTool } from '@wispcrew/tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-quoting-'));
const spaced = path.join(dir, 'a folder with spaces');
fs.mkdirSync(spaced, { recursive: true });
const file = path.join(spaced, 'marker.txt');
fs.writeFileSync(file, 'CONTENT_MARKER\n');

const ctx = {
  workspaceRoot: dir,
  defaultTimeoutMs: 20_000,
  requestApproval: async () => true,
};
const isWin = process.platform === 'win32';

console.log('\n[quoted path mid-command]');
{
  const r = await shellTool.run({ command: isWin ? `type "${file}"` : `cat "${file}"` }, ctx);
  check('a spaced path is readable', String(r.content ?? '').includes('CONTENT_MARKER'),
    String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 140));
}

console.log('\n[command that begins AND ends with a quote]');
{
  // The cmd /s stripping rule bites exactly here, and this is the shape of
  // every `"C:\path\tool.exe" ... "last arg"` command.
  const r = await shellTool.run(
    { command: `"${process.execPath}" -e "console.log('QUOTED_OK')"` },
    ctx,
  );
  check('it runs', String(r.content ?? '').includes('QUOTED_OK'),
    String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 160));
}

console.log('\n[no backslash-escaped quotes reach the shell]');
{
  const r = await shellTool.run(
    { command: `"${process.execPath}" -e "console.log('ESCAPE_CHECK')"` },
    ctx,
  );
  const out = String(r.content ?? '');
  check('no literal \\" in the error stream', !out.includes('\\"'), out.slice(0, 160));
  check('the command succeeded', out.includes('ESCAPE_CHECK'));
}

console.log('\n[the reported shape: quoted exe, quoted -i path, bare host]');
{
  /*
   * `--` stops Node treating the following tokens as its own flags.
   *
   * Without it, `-i <file>` made Node *execute* the file — the arguments had
   * survived perfectly and my assertion was wrong, not the tool. Worth
   * keeping the note: a test that misreads its own harness looks exactly
   * like a bug in the code under test.
   */
  const r = await shellTool.run(
    {
      command:
        `"${process.execPath}" -e "console.log(process.argv.slice(1).join('|'))" -- ` +
        `-i "${file}" user@example.invalid`,
    },
    ctx,
  );
  const out = String(r.content ?? '');
  check('every argument survives', out.includes('marker.txt') && out.includes('user@example.invalid'),
    out.replace(/\s+/g, ' ').slice(0, 200));
  check('the spaced path is one argument', !out.includes('|a|folder|with|spaces'),
    out.replace(/\s+/g, ' ').slice(0, 200));
}

console.log('\n[still reports real failures honestly]');
{
  const r = await shellTool.run({ command: 'definitely-not-a-real-command-xyz' }, ctx);
  check('an unknown command fails', r.ok === false);
  check('and is not mistaken for a timeout', r.errorCode !== 'timeout', String(r.errorCode));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`SHELL-QUOTING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SHELL-QUOTING TEST PASSED\n');
