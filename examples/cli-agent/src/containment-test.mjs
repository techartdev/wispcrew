/**
 * containment-test.mjs — a tool cannot reach outside the agent's workspace.
 *
 * Hard rule 6 says file tools stay inside the workspace root. It was true of
 * `read_file`, `write_file`, `list_dir` and `edit_file` — and quietly false
 * of `grep` and `shell`, which each resolved a model-supplied path their own
 * way and checked nothing.
 *
 * How it surfaced: an agent whose workspace was `D:\Mine\OpenClawHomeAssistant`
 * ran `git remote -v` and reported `techartdev/wispcrew`, a repository in a
 * completely different folder. It was not hallucinating — it was reading a
 * real answer from outside its boundary and reasoning confidently on top of
 * it. A boundary that holds for four tools out of six is worse than none,
 * because the prompt promises it.
 *
 * ## The trap that made two implementations insufficient
 *
 *     path.resolve('/workspace', '/etc')   // => '/etc'
 *
 * `path.resolve` discards everything left of an absolute segment, so
 * `path.resolve(root, args.path)` silently honours any absolute path. It
 * READS like containment. That is why this suite tests behaviour rather than
 * inspecting the expression.
 *
 * Offline: tools only, on temporary directories.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  grepTool,
  shellTool,
  readFileTool,
  writeFileTool,
  listDirTool,
  editFileTool,
} from '@wispcrew/tools';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-box-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-outside-'));

fs.mkdirSync(path.join(box, 'sub'), { recursive: true });
fs.writeFileSync(path.join(box, 'inside.txt'), 'CANARY-INSIDE\n');
fs.writeFileSync(path.join(box, 'sub', 'nested.txt'), 'CANARY-NESTED\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'CANARY-OUTSIDE\n');

const ctx = {
  workspaceRoot: box,
  defaultTimeoutMs: 15000,
  requestApproval: async () => true,
};

/** Did the result leak the file that lives outside the workspace? */
const leaked = (result) => String(result?.content ?? '').includes('CANARY-OUTSIDE');

const isWin = process.platform === 'win32';
const secret = path.join(outside, 'secret.txt');
const upToOutside = path.relative(box, outside);

console.log('\n[grep] an absolute path must not redirect the search');
{
  const r = await grepTool.run({ pattern: 'CANARY', path: outside }, ctx);
  check('refused', !leaked(r), 'it searched outside the workspace');
  check('with a named error', r.errorCode === 'outside_workspace', r.errorCode);
  // The message has to say WHERE the boundary is, or the model retries the
  // same call with a different spelling of the same path.
  check('naming the workspace', String(r.content).includes(box), r.content);
}

console.log('\n[grep] and neither must ../ traversal');
{
  const r = await grepTool.run({ pattern: 'CANARY', path: upToOutside }, ctx);
  check('refused', !leaked(r));
  check('with a named error', r.errorCode === 'outside_workspace', r.errorCode);
}

console.log('\n[grep] but it still works inside');
{
  const r = await grepTool.run({ pattern: 'CANARY', path: 'sub' }, ctx);
  check('a relative subdirectory is searched', String(r.content).includes('CANARY-NESTED'),
    r.content);

  const all = await grepTool.run({ pattern: 'CANARY-INSIDE' }, ctx);
  check('and the default is the whole workspace', String(all.content).includes('inside.txt'),
    all.content);

  /*
   * An absolute path that is genuinely INSIDE must keep working. A model
   * echoing back a path a tool just printed is the common case, and
   * refusing it would break ordinary use to close a hole it is not in.
   */
  const abs = await grepTool.run({ pattern: 'CANARY', path: path.join(box, 'sub') }, ctx);
  check('an absolute path inside is allowed', String(abs.content).includes('CANARY-NESTED'),
    abs.content);
}

console.log('\n[shell] a cwd outside the workspace must not be honoured');
{
  /*
   * This is the one that produced the wrong repository. `args.cwd` was used
   * verbatim — and the tool's own description advertised it, so a model
   * reaching for it was doing exactly what it was told.
   */
  const r = await shellTool.run(
    { command: isWin ? 'type secret.txt' : 'cat secret.txt', cwd: outside },
    ctx,
  );
  check('refused', !leaked(r), 'the command ran outside the workspace');
  check('with a named error', r.errorCode === 'outside_workspace', r.errorCode);

  const up = await shellTool.run(
    { command: isWin ? 'type secret.txt' : 'cat secret.txt', cwd: upToOutside },
    ctx,
  );
  check('and ../ is refused too', !leaked(up) && up.errorCode === 'outside_workspace');
}

console.log('\n[shell] the refusal happens before the approval card');
{
  /*
   * Two reasons it must be first. The card quotes the cwd, so asking about
   * a directory the command would not run in asks the user to agree to the
   * wrong thing — and a request that will be refused anyway should not cost
   * somebody a decision.
   */
  let asked = null;
  const spy = {
    ...ctx,
    requestApproval: async (req) => {
      asked = req;
      return true;
    },
  };

  await shellTool.run({ command: 'echo hi', cwd: outside }, spy);
  check('nothing was asked', asked === null, JSON.stringify(asked?.detail));

  await shellTool.run({ command: 'echo hi', cwd: 'sub' }, spy);
  check('an allowed cwd does ask', asked !== null);
  // And the card shows the RESOLVED directory, not the raw argument.
  check('quoting where it will really run',
    String(asked?.detail).includes(path.join(box, 'sub')), asked?.detail);
}

console.log('\n[shell] and it still runs inside');
{
  const r = await shellTool.run(
    { command: isWin ? 'type inside.txt' : 'cat inside.txt' },
    ctx,
  );
  check('the default cwd is the workspace', String(r.content).includes('CANARY-INSIDE'), r.content);

  const sub = await shellTool.run(
    { command: isWin ? 'type nested.txt' : 'cat nested.txt', cwd: 'sub' },
    ctx,
  );
  check('and a relative cwd works', String(sub.content).includes('CANARY-NESTED'), sub.content);
}

console.log('\n[file tools] the ones that were already correct, still are');
{
  const r = await readFileTool.run({ path: secret }, ctx);
  check('read_file refuses an absolute path outside', !leaked(r));

  const l = await listDirTool.run({ path: outside }, ctx);
  check('list_dir refuses it', !String(l.content).includes('secret.txt'), l.content);

  const w = await writeFileTool.run(
    { path: path.join(outside, 'written.txt'), content: 'nope' },
    ctx,
  );
  check('write_file refuses it', !fs.existsSync(path.join(outside, 'written.txt')), w.content);

  const e = await editFileTool.run(
    { path: secret, oldText: 'CANARY-OUTSIDE', newText: 'edited' },
    ctx,
  );
  check('edit_file refuses it', e.errorCode === 'outside_workspace', e.errorCode);
  check('and the file is untouched',
    fs.readFileSync(secret, 'utf8').includes('CANARY-OUTSIDE'));
}

console.log('\n[one rule] the containment check lives in exactly one place');
{
  /*
   * The escape existed because the rule was written twice and omitted
   * twice. A private copy in a third tool is how it comes back.
   */
  const dir = path.join(repo, 'packages/tools/src');
  const offenders = [];

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.ts') || name === 'workspace.ts') continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // The shape of a hand-rolled containment check.
    if (/startsWith\(root \+ path\.sep\)/.test(src)) offenders.push(name);
  }

  check('no tool rolls its own', offenders.length === 0, offenders.join(', '));

  const shared = fs.readFileSync(path.join(dir, 'workspace.ts'), 'utf8');
  check('the shared one compares after resolving',
    /path\.resolve\(root, p\)/.test(shared) && /isInsideRoot/.test(shared));
  // A prefix match without the separator accepts `/workspace-other`.
  check('and requires a separator', /root \+ path\.sep/.test(shared));
}

console.log('\n[honesty] the prompt does not promise more than a shell can give');
{
  /*
   * Containing a shell needs the operating system, not a string check: a
   * command can `cd`, use `git -C`, or name an absolute path. The prompt
   * used to say file AND shell tools were "confined", which is what let an
   * agent trust an answer that came from outside its boundary.
   */
  const prompt = fs.readFileSync(path.join(repo, 'packages/core/src/prompt.ts'), 'utf8');
  check('file tools are still described as confined', /File tools are confined to it/.test(prompt));
  check('the shell is described as starting there', /Shell commands START there/.test(prompt));
  check('and explicitly not as a sandbox',
    /working directory, not a sandbox/.test(prompt), 'the prompt overstates containment');
  check('with advice to check where it is',
    /check where you are/.test(prompt));
}

console.log('\n[diagnosis] a finished tool call still records what it was asked');
{
  /*
   * The result entry REPLACES the start entry — `upsertTranscriptEntry`
   * overwrites by id — so arguments were destroyed the moment a call
   * finished. That made "did it pass a cwd, or did it cd out?" unanswerable
   * from the transcript, and those have different causes and different
   * fixes.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  check('arguments are remembered per call', /calledWith\.set\(e\.call\.id/.test(engine));
  check('and written onto the result', /args: calledWith\.get\(e\.result\.id\)/.test(engine));
  // Cleared as results arrive, so a long turn does not accumulate them all.
  check('then released', /calledWith\.delete\(e\.result\.id\)/.test(engine));
}

console.log('\n[stale history] moving the workspace is said out loud');
{
  /*
   * The other half of the reported confusion, and the half no containment
   * fix addresses. Pointing an EXISTING agent at a project folder is the
   * ordinary way to start work on one — and the agent keeps a history full
   * of true answers about the previous folder. Asked which repository it
   * was in, it named the old one, having read that from its own earlier
   * turn rather than from the disk.
   *
   * A prompt describes the present. It says nothing about a change, so the
   * model cannot tell which of its earlier observations went stale.
   */
  const engine = fs.readFileSync(path.join(repo, 'packages/runtime/src/engine.ts'), 'utf8');
  const store = fs.readFileSync(path.join(repo, 'packages/runtime/src/store.ts'), 'utf8');

  check('the store reports a moved workspace', /setWorkspaceMovedHook/.test(store));
  check('comparing against what it WAS',
    /const previousRoot = agents\[idx\]!\.workspaceRoot;/.test(store));
  check('and the engine writes it into the conversation',
    /Workspace changed from/.test(engine));
  // The warning is the point: the entry exists to mark earlier answers stale.
  check('warning that earlier answers may be stale',
    /refers to the previous folder/.test(engine));
}

fs.rmSync(box, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`CONTAINMENT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('CONTAINMENT TEST PASSED\n');
