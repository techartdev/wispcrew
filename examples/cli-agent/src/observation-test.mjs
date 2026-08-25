/**
 * observation-test.mjs — you cannot overwrite what you have not read.
 *
 * `write_file` replaces a file wholesale, so an unexamined write silently
 * destroys content nobody reviewed. Twice in this project's own history that
 * is exactly what happened: an automated edit truncated three source files
 * to zero bytes, and a cleanup script destroyed a real conversation.
 *
 * Offline: files only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearObserved, readFileTool, writeFileTool, editFileTool } from '@wispcrew/tools';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-observe-'));
const ctx = {
  workspaceRoot: dir,
  defaultTimeoutMs: 10_000,
  requestApproval: async () => true,
};

clearObserved();

console.log('\n[new file] creating destroys nothing, so it is allowed');
{
  const r = await writeFileTool.run({ path: 'fresh.txt', content: 'hello' }, ctx);
  check('the write succeeded', r.ok === true, String(r.errorCode));
  check('the file exists', fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8') === 'hello');
}

console.log('\n[unread] overwriting an existing file is refused');
{
  fs.writeFileSync(path.join(dir, 'valuable.txt'), 'IRREPLACEABLE CONTENT');
  clearObserved();

  const r = await writeFileTool.run({ path: 'valuable.txt', content: 'oops' }, ctx);
  check('the write was refused', r.ok === false);
  check('named as an unobserved write', r.errorCode === 'unobserved_write', String(r.errorCode));
  check('and says what to do', /read the file/i.test(String(r.content)), String(r.content));

  // The assertion that matters.
  check('the original is intact',
    fs.readFileSync(path.join(dir, 'valuable.txt'), 'utf8') === 'IRREPLACEABLE CONTENT');
}

console.log('\n[read then write] the normal path works');
{
  const read = await readFileTool.run({ path: 'valuable.txt' }, ctx);
  check('the read succeeded', read.ok === true);

  const write = await writeFileTool.run({ path: 'valuable.txt', content: 'deliberate' }, ctx);
  check('the write is now allowed', write.ok === true, String(write.errorCode));
  check('and took effect',
    fs.readFileSync(path.join(dir, 'valuable.txt'), 'utf8') === 'deliberate');
}

console.log('\n[stale] a file changed since it was read is refused');
{
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'version one');
  clearObserved();
  await readFileTool.run({ path: 'shared.txt' }, ctx);

  // Something else edits it — another process, the user, a second agent.
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'version two, edited elsewhere');

  const r = await writeFileTool.run({ path: 'shared.txt', content: 'version three' }, ctx);
  check('the stale write was refused', r.ok === false);
  check('named as stale', r.errorCode === 'stale_write', String(r.errorCode));
  check("the other edit survives",
    fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') === 'version two, edited elsewhere');

  // Re-reading clears the objection.
  await readFileTool.run({ path: 'shared.txt' }, ctx);
  const retry = await writeFileTool.run({ path: 'shared.txt', content: 'version three' }, ctx);
  check('re-reading allows the write', retry.ok === true, String(retry.errorCode));
}

console.log('\n[append] adding without removing is unrestricted');
{
  fs.writeFileSync(path.join(dir, 'log.txt'), 'existing line\n');
  clearObserved();

  const r = await writeFileTool.run({ path: 'log.txt', content: 'new line\n', append: true }, ctx);
  check('appending is allowed unread', r.ok === true, String(r.errorCode));
  const after = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8');
  check('the original line survives', after.includes('existing line'));
  check('and the new one was added', after.includes('new line'));
}

console.log('\n[partial read] does not license an overwrite');
{
  fs.writeFileSync(path.join(dir, 'big.txt'), 'A'.repeat(5000));
  clearObserved();

  // Reading part of a file leaves the rest unseen.
  await readFileTool.run({ path: 'big.txt', limit: 100 }, ctx);

  const r = await writeFileTool.run({ path: 'big.txt', content: 'tiny' }, ctx);
  check('a partial read is not enough', r.ok === false, String(r.errorCode));
  check('the file is intact', fs.readFileSync(path.join(dir, 'big.txt'), 'utf8').length === 5000);
}

console.log('\n[edit] editing a file counts as observing it');
{
  fs.writeFileSync(path.join(dir, 'code.txt'), 'const a = 1;\n');
  clearObserved();

  const edit = await editFileTool.run(
    { path: 'code.txt', oldText: 'const a = 1;', newText: 'const a = 2;' },
    ctx,
  );
  check('the edit succeeded', edit.ok === true, String(edit.content));

  // An edit reads, replaces a known substring, and writes — the contents are
  // known exactly, so a follow-up write needs no fresh read.
  const write = await writeFileTool.run({ path: 'code.txt', content: 'const a = 3;\n' }, ctx);
  check('a follow-up write is allowed', write.ok === true, String(write.errorCode));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`OBSERVATION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('OBSERVATION TEST PASSED\n');
