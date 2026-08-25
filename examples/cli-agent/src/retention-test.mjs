/**
 * retention-test.mjs — large tool output is bounded, not destroyed.
 *
 * The shell tool used to cut each stream at 200 KB, append
 * "[stdout truncated]" and drop the rest. The model learned almost nothing
 * about what it lost, and the user debugging a long build could not see the
 * remainder at all.
 *
 * Separately, hitting that cap set the timed-out flag, so a merely chatty
 * command was reported as having timed out. It had not.
 *
 * Offline: local processes only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retainText, shellTool } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-retain-'));
const spillDir = path.join(dir, 'spill');

console.log('\n[small] short output is untouched');
{
  const r = retainText('hello world', { spillDir });
  check('returned verbatim', r.text === 'hello world');
  check('nothing omitted', r.omitted === 0);
  check('no spill file created', r.spillFile === undefined);
}

console.log('\n[large] the ends are kept and the middle is spilled');
{
  // Distinct markers at each end so their survival is provable.
  const body = 'MIDDLE_FILLER '.repeat(20_000);
  const raw = `START_MARKER\n${body}\nEND_MARKER`;
  const r = retainText(raw, { limit: 2000, spillDir, label: 'test' });

  check('the result is bounded', r.text.length < 4000, String(r.text.length));
  check('the beginning survives', r.text.includes('START_MARKER'));
  check('the end survives', r.text.includes('END_MARKER'));
  check('something was omitted', r.omitted > 0, String(r.omitted));

  // The notice must be specific enough to act on.
  check('it says how much was omitted', /characters omitted/i.test(r.text), r.text.slice(0, 200));
  check('and where the rest is', r.text.includes(r.spillFile ?? '\u0000'));

  check('the spill file exists', Boolean(r.spillFile) && fs.existsSync(r.spillFile));
  const spilled = fs.readFileSync(r.spillFile, 'utf8');
  check('and holds the WHOLE output', spilled.length === raw.length,
    `${spilled.length} vs ${raw.length}`);
  check('including the middle that was elided', spilled.includes('MIDDLE_FILLER'));
}

console.log('\n[unwritable] a failed spill still bounds the text');
{
  // A path that cannot be created: the tool must degrade, not throw.
  const r = retainText('x'.repeat(5000), { limit: 500, spillDir: '\u0000/impossible' });
  check('the text is still bounded', r.text.length < 1500, String(r.text.length));
  check('and says the output could not be saved', /could not be saved/i.test(r.text));
}

console.log('\n[shell] a chatty command is not reported as a timeout');
{
  const isWin = process.platform === 'win32';
  const ctx = { workspaceRoot: dir, defaultTimeoutMs: 20_000, requestApproval: async () => true };

  // Produce a lot of output quickly, well within the time limit.
  const command = isWin
    ? 'for /l %i in (1,1,3000) do @echo line %i with some padding text to make it longer'
    : 'for i in $(seq 1 3000); do echo "line $i with some padding text to make it longer"; done';

  const r = await shellTool.run({ command, timeoutMs: 20_000 }, ctx);

  check('the command succeeded', r.ok === true, String(r.errorCode));
  // This is the bug: volume used to masquerade as a timeout.
  check('it is NOT reported as a timeout', r.errorCode !== 'timeout', String(r.errorCode));
  check('the output does not claim a timeout', !/timed out/i.test(String(r.content ?? '')));
  check('and the result is bounded', String(r.content ?? '').length < 200_000,
    String(String(r.content ?? '').length));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`RETENTION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('RETENTION TEST PASSED\n');
