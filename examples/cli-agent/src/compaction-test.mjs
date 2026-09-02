/**
 * compaction-test.mjs — making room without losing the thread.
 *
 * Trimming the oldest messages is the obvious way to fit inside a context
 * window and the wrong one: what falls off the front of a long project
 * conversation is what the person put there first — the goal, the
 * constraints, the decisions everything since rests on. So the recent turns
 * are kept EXACTLY, and everything before them becomes a summary.
 *
 * Three properties make that safe rather than clever, and all three are
 * pinned here:
 *
 *  - the previous version is checkpointed BEFORE the write, so "that summary
 *    lost something" is one click and not an apology;
 *  - the kept turns are byte-identical, not merely present;
 *  - a tool call is never separated from its result, because a provider
 *    rejects the whole conversation for it and the error names nothing.
 *
 * Offline: a stub summariser, so no provider is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoCompactIfNeeded,
  compactConversation,
  createAgent,
  createNodeCrypto,
  initStore,
  listCheckpoints,
  loadTranscript,
  readCheckpoint,
  rebuildHistory,
  renderForSummary,
  saveTranscript,
  setHost,
  setSummariser,
  splitPoint,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-compact-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

let asked = null;
setSummariser(async (agentId, text) => {
  asked = { agentId, text };
  return 'The user wants X. We decided Y because Z. Next: W.';
});

const agent = createAgent({ name: 'Builder', presetId: 'openai', model: 'gpt-5.6-luna' });

const msg = (i, role = 'user') => ({
  kind: 'message',
  id: `m${i}`,
  role,
  content: `message number ${i}`,
  createdAt: 1000 + i,
});

const toolCall = (i) => ({
  kind: 'tool-call',
  id: `t${i}`,
  toolName: 'shell',
  args: { command: `echo ${i}` },
  status: 'completed',
  content: `output ${i}`,
  createdAt: 1000 + i,
});

const fill = (n, at = (i) => msg(i)) => Array.from({ length: n }, (_, i) => at(i));

console.log('\n[too short] a refusal is an answer, not a failure');
{
  saveTranscript(agent.id, fill(5));
  const r = await compactConversation(agent.id);

  check('it refuses', r.ok === false);
  /*
   * And says which. Somebody who pressed a button and saw nothing happen
   * has been told the operation failed, whatever the return value says.
   */
  check('naming the reason', /nothing worth compacting/.test(r.reason ?? ''), r.reason);
  check('and the transcript is untouched', loadTranscript(agent.id).length === 5);
}

console.log('\n[split] a tool call is never parted from its result');
{
  /*
   * A `tool-call` entry becomes TWO model messages: the assistant's request
   * and the result. Beginning the kept half on one leaves the request in
   * the summarised half and the result outside it, and the provider
   * rejects the entire conversation with an error that names nothing
   * useful.
   */
  const entries = [...fill(10), toolCall(90), toolCall(91), ...fill(3, (i) => msg(100 + i))];
  const cut = splitPoint(entries, 5);

  check('the boundary moves off a tool call', entries[cut]?.kind !== 'tool-call',
    entries[cut]?.kind);
  check('and it moves backwards, never forwards', cut <= entries.length - 5, String(cut));

  // With no tool calls it lands exactly where asked.
  check('otherwise it is exact', splitPoint(fill(10), 4) === 6, String(splitPoint(fill(10), 4)));
  // And never before the beginning.
  check('never past the start', splitPoint(fill(3), 99) === 0);
}

console.log('\n[compacting] the recent turns survive byte for byte');
{
  const entries = fill(40);
  saveTranscript(agent.id, entries);

  const r = await compactConversation(agent.id, agent.id, { keepRecent: 10, minEntries: 20 });

  check('it succeeds', r.ok === true, r.reason);
  check('replacing the older ones', r.replaced === 30, String(r.replaced));
  check('and keeping the recent ones', r.kept === 10, String(r.kept));

  const after = loadTranscript(agent.id);
  check('the summary stands first', after[0]?.kind === 'notice' && after[0]?.summary === true);
  check('followed by exactly what was kept', after.length === 11, String(after.length));

  /*
   * Byte-identical, not "looks the same". A compaction that quietly
   * reformatted the turns it claims to have preserved would be the same
   * class of loss as one that dropped them.
   */
  check('and they are unchanged',
    JSON.stringify(after.slice(1)) === JSON.stringify(entries.slice(30)));

  // The summary has to reach the model — it IS the memory now.
  const history = rebuildHistory(after);
  check('the summary reaches the model',
    JSON.stringify(history).includes('We decided Y because Z'));
}

console.log('\n[recovery] the previous version is saved first');
{
  /*
   * Compaction is a destructive edit to somebody's conversation. The
   * checkpoint goes in BEFORE the write, and its reason names what was
   * about to happen — that label is the whole basis on which somebody picks
   * which saved version they want back.
   */
  const saved = listCheckpoints(dir, agent.id);
  check('a checkpoint exists', saved.length > 0, String(saved.length));

  const labelled = saved.find((c) => /before compacting/.test(c.reason ?? ''));
  check('labelled with what was about to happen', Boolean(labelled),
    saved.map((c) => c.reason).join(', '));

  const restored = labelled ? readCheckpoint(labelled.file) : null;
  check('and it restores the whole conversation', restored?.length === 40,
    String(restored?.length));
}

console.log('\n[the summariser] is asked with the agent\u2019s own id');
{
  // So it costs that agent's provider, not silently somebody else's.
  check('the owning agent is named', asked?.agentId === agent.id, asked?.agentId);
  check('and given the older turns', /message number 0/.test(asked?.text ?? ''));
  check('but not the kept ones', !/message number 39/.test(asked?.text ?? ''));
}

console.log('\n[already compacted] a summary is not summarised again');
{
  /*
   * Re-summarising a summary loses a little more every time, and a
   * conversation that is one summary plus a short tail has nothing left to
   * gain.
   */
  const r = await compactConversation(agent.id, agent.id, { keepRecent: 10, minEntries: 5 });
  check('it refuses', r.ok === false);
  check('saying it is already compacted', /already compacted/i.test(r.reason ?? ''), r.reason);
}

console.log('\n[an empty summary changes nothing]');
{
  setSummariser(async () => '   ');
  saveTranscript(agent.id, fill(40));

  const r = await compactConversation(agent.id, agent.id, { keepRecent: 10, minEntries: 20 });

  /*
   * Replacing real turns with nothing is the exact outcome compaction
   * exists to avoid, and a model that returned nothing has told us nothing
   * about why.
   */
  check('it refuses', r.ok === false);
  check('naming the cause', /empty summary/.test(r.reason ?? ''), r.reason);
  check('and the conversation is intact', loadTranscript(agent.id).length === 40);
}

console.log('\n[a failing summariser does not damage anything]');
{
  setSummariser(async () => {
    throw new Error('provider unreachable');
  });

  const r = await compactConversation(agent.id, agent.id, { keepRecent: 10, minEntries: 20 });
  check('it refuses', r.ok === false);
  check('reporting why', /provider unreachable/.test(r.reason ?? ''), r.reason);
  check('and the conversation is intact', loadTranscript(agent.id).length === 40);
}

console.log('\n[automatic] a threshold, and a refusal to guess at one');
{
  const over = { fraction: 0.95, limit: 200_000 };
  const under = { fraction: 0.4, limit: 200_000 };

  setSummariser(async () => 'a summary');
  saveTranscript(agent.id, fill(60));

  check('under the threshold, nothing happens',
    (await autoCompactIfNeeded(agent.id, agent.id, under)) === null);
  check('and the conversation is untouched', loadTranscript(agent.id).length === 60);

  const fired = await autoCompactIfNeeded(agent.id, agent.id, over);
  check('over it, compaction runs', fired?.ok === true, JSON.stringify(fired));
  check('and the conversation shrinks', loadTranscript(agent.id).length < 60,
    String(loadTranscript(agent.id).length));

  /*
   * The rule that matters most, and the one a shipped tool got wrong.
   * Claude Code compacted at ~76K tokens on a 1M-context model because the
   * threshold was computed against an assumed window, discarding history
   * with 92% of the context unused. No known limit means no automatic
   * action, ever — the same reasoning as never inventing a denominator for
   * the meter, and this is the damage that rule prevents.
   */
  saveTranscript(agent.id, fill(60));

  check('an unknown limit never triggers it',
    (await autoCompactIfNeeded(agent.id, agent.id, { fraction: undefined, limit: undefined })) === null);
  check('nor a fraction with no limit behind it',
    (await autoCompactIfNeeded(agent.id, agent.id, { fraction: 0.99, limit: undefined })) === null);
  check('and the conversation is untouched', loadTranscript(agent.id).length === 60);

  /*
   * Over the threshold but too short to help: the space is going on the
   * system prompt or the tool list, which a summary cannot fix. It declines
   * quietly rather than spending a model call every turn to achieve
   * nothing.
   */
  saveTranscript(agent.id, fill(4));
  check('too short to help declines quietly',
    (await autoCompactIfNeeded(agent.id, agent.id, over)) === null);
  check('leaving it alone', loadTranscript(agent.id).length === 4);
}

console.log('\n[rendering] tool output is summarised, not transcribed');
{
  /*
   * What matters months later is that a command was run, not the four
   * thousand characters it printed. Keeping full output would make the text
   * to be summarised as large as the thing being compacted.
   */
  const huge = { ...toolCall(1), content: 'x'.repeat(5000) };
  const text = renderForSummary([msg(1), huge]);

  check('the tool is named', /\[tool shell/.test(text), text.slice(0, 120));
  check('with its arguments', /echo 1/.test(text));
  check('but its output is bounded', text.length < 1200, String(text.length));

  // An error notice is noise for a summary: the model already met it.
  const withError = renderForSummary([
    { kind: 'notice', id: 'n', level: 'error', text: 'fetch failed', createdAt: 1 },
  ]);
  check('errors are left out', !/fetch failed/.test(withError), withError);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`COMPACTION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('COMPACTION TEST PASSED\n');
