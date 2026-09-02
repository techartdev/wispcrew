/**
 * tool-budget-test.mjs — a turn that runs out of steps still reports.
 *
 * And the reason it ran out in the first place: on Windows, `edit_file` could
 * not match anything.
 *
 * Both came from one report. An agent asked to resolve a git merge produced
 * nine failed tool calls and then "Reached the maximum number of tool steps
 * without a final answer." It had already run `git checkout --ours` on two
 * files — real work, in an unknown state, with no report of it.
 *
 * ## Why the edits failed
 *
 * `edit_file` matched a literal substring. Git's default on Windows is
 * `core.autocrlf=true`, which checks every file out with CRLF — measured on
 * the user's repository: 1490 CRLF lines and not one bare LF — while a model
 * writes `\n`. So every multi-line edit failed, the agent escalated to a
 * shell heredoc (cmd.exe has none) and then to base64-encoded Python, and
 * the budget was gone.
 *
 * Offline: the edit tool on temp files, and a scripted provider.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editFileTool, ToolRegistry } from '@wispcrew/tools';
import { Agent } from '@wispcrew/core';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-budget-'));
const ctx = { workspaceRoot: dir, defaultTimeoutMs: 5000, requestApproval: async () => true };

const write = (name, text) => {
  fs.writeFileSync(path.join(dir, name), text);
  return name;
};
const readBytes = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

console.log('\n[CRLF] an LF oldText matches a CRLF file');
{
  write('crlf.sh', '#!/bin/sh\r\nA=1\r\nB=2\r\nC=3\r\n');

  const r = await editFileTool.run(
    { path: 'crlf.sh', oldText: 'A=1\nB=2', newText: 'A=9\nB=8' },
    ctx,
  );

  check('the edit succeeds', r.ok === true, r.content);

  const after = readBytes('crlf.sh');
  check('the replacement went in', after.includes('A=9') && after.includes('B=8'), after);

  /*
   * The file must stay pure CRLF. Normalising the whole file would have
   * been simpler and would rewrite every line of a file somebody asked to
   * change three characters in — invisible in a diff viewer, enormous in a
   * commit.
   */
  check('the file is still pure CRLF', !/[^\r]\n/.test(after), JSON.stringify(after));
  check('and untouched lines are byte-identical', after.endsWith('C=3\r\n'), JSON.stringify(after));
}

console.log('\n[LF] a CRLF oldText matches an LF file');
{
  write('lf.sh', '#!/bin/sh\nA=1\nB=2\nC=3\n');

  const r = await editFileTool.run(
    { path: 'lf.sh', oldText: 'A=1\r\nB=2', newText: 'A=9\r\nB=8' },
    ctx,
  );
  check('the edit succeeds', r.ok === true, r.content);

  const after = readBytes('lf.sh');
  check('and no CR is introduced', !after.includes('\r'), JSON.stringify(after));
}

console.log('\n[literal first] an exact match is used unchanged');
{
  /*
   * When the literal matches, none of the conversion is observable — the
   * exact bytes asked for are replaced. Pinned with a file that has BOTH
   * conventions, where converting would pick the wrong region.
   */
  write('mixed.txt', 'keep\r\ntarget\r\nkeep\ntarget\nend\n');

  const r = await editFileTool.run(
    { path: 'mixed.txt', oldText: 'keep\ntarget', newText: 'keep\nCHANGED' },
    ctx,
  );
  check('the LF region is the one replaced', r.ok === true, r.content);

  const after = readBytes('mixed.txt');
  check('the CRLF region is untouched', after.includes('keep\r\ntarget\r\n'), JSON.stringify(after));
  check('and the LF region changed', after.includes('keep\nCHANGED'), JSON.stringify(after));
}

console.log('\n[still refuses] text that genuinely is not there');
{
  write('plain.txt', 'hello\r\nworld\r\n');

  const r = await editFileTool.run(
    { path: 'plain.txt', oldText: 'nothing like this', newText: 'x' },
    ctx,
  );
  check('not found', r.ok === false && r.errorCode === 'not_found', r.errorCode);

  /*
   * The message has to say why when the reason is knowable. "oldText not
   * found" sent a model into guesswork and cost it nine calls; naming the
   * convention lets it stop suspecting the line endings and re-read.
   */
  check('and says the file is CRLF', /Windows line endings/.test(r.content), r.content);
  check('and what to do instead', /Read the file again/.test(r.content), r.content);
}

console.log('\n[budget] running out produces a report, not a shrug');
{
  /*
   * A provider that only ever asks for another tool call, so the loop
   * cannot finish on its own. The LAST call is the one under test: it must
   * arrive with no tool definitions, and its answer becomes the turn's
   * result.
   */
  const seen = [];
  let calls = 0;

  const provider = {
    async *chat(req) {
      calls++;
      seen.push((req.toolDefs ?? []).length);

      // No tools offered means this is the summary call.
      if ((req.toolDefs ?? []).length === 0) {
        yield { kind: 'text', text: 'I renamed two files and stopped half-way; the merge is unresolved.' };
        yield {
          kind: 'done',
          message: { role: 'assistant', content: 'I renamed two files and stopped half-way; the merge is unresolved.' },
        };
        return;
      }

      const call = { id: `c${calls}`, name: 'noop', args: {} };
      yield { kind: 'tool_call', call };
      yield { kind: 'done', message: { role: 'assistant', content: '', toolCalls: [call] } };
    },
  };

  // The real registry with one harmless tool, rather than a hand-rolled
  // stand-in — a fake would only pin the shape of the fake.
  const tools = new ToolRegistry([
    {
      definition: {
        name: 'noop',
        description: 'does nothing',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => ({ id: '', name: 'noop', ok: true, content: 'ok' }),
    },
  ]);

  const agent = new Agent({ provider, tools, maxSteps: 3, systemPrompt: 'test' });
  const reply = await agent.run('resolve the merge');

  check('the turn still answers', typeof reply.content === 'string' && reply.content.length > 0);
  check('with the summary, not a shrug',
    /renamed two files/.test(reply.content), reply.content);
  check('and never the old dead end',
    !/without a final answer/.test(reply.content), reply.content);

  // maxSteps model calls, then exactly one more for the summary.
  check('one extra call, no more', calls === 4, `${calls} calls`);
  check('and the last one offered no tools', seen[seen.length - 1] === 0, JSON.stringify(seen));
  check('while the earlier ones did', seen[0] > 0, JSON.stringify(seen));
}

console.log('\n[budget] the instruction forbids asking to continue');
{
  /*
   * "Shall I carry on?" is not a report. The turn is over either way, and
   * an offer to continue reads as a question the user must answer before
   * anything is recoverable.
   */
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', '..');
  const agentSrc = fs.readFileSync(path.join(repo, 'packages/core/src/agent.ts'), 'utf8');

  check('it asks what changed', /what you actually changed/.test(agentSrc));
  check('and what state things are in', /what state things are in/.test(agentSrc));
  check('and what remains', /what still needs doing/.test(agentSrc));
  check('and forbids offering to continue', /do not offer to continue/.test(agentSrc));
  // The mechanism, not just the wording: a tool that is offered gets used.
  check('the summary call passes no tools', /toolDefs: \[\],/.test(agentSrc));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`TOOL-BUDGET TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TOOL-BUDGET TEST PASSED\n');
