/**
 * routine-turn-test.mjs — unattended work leaves a record.
 *
 * Turns were claimed only by room turns, so a cron routine, a file watch and
 * a self-scheduled follow-up left no trace an operator could query.
 * `wispcrew tasks` on a server showed the work a person had started and
 * nothing that happened while they slept — exactly the wrong way round for a
 * machine with no screen.
 *
 * Found by scheduling a routine for the next minute on a real clock: it
 * fired, the agent answered, and `listTurns` was empty.
 *
 * Offline: the turn store, with the engine's own claim shape.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimTurn,
  createAgentWithRoom,
  createNodeCrypto,
  initStore,
  listTurns,
  setHost,
  updateTurn,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-routineturn-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'n', crypto: createNodeCrypto(dir) });
initStore(dir);

const agent = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Scheduled' });

/** What `runRoutine` does, in the shape it does it. */
const claimForRoutine = (routineId) =>
  claimTurn({
    conversationId: agent.id,
    triggerEntryId: `routine_${routineId}_${Date.now()}`,
    agentId: agent.id,
  });

console.log('\n[a routine run is a task]');
{
  const turn = claimForRoutine('r1');
  check('a turn is claimed', Boolean(turn));

  updateTurn(turn.id, { state: 'running' });
  updateTurn(turn.id, { state: 'completed' });

  const found = listTurns(agent.id);
  check('and is findable afterwards', found.length === 1, String(found.length));
  check('marked completed', found[0]?.state === 'completed', found[0]?.state);

  // The trigger names the routine, so a run can be traced back to what
  // scheduled it rather than appearing from nowhere.
  check('the trigger names the routine', String(found[0]?.triggerEntryId).includes('r1'));
}

console.log('\n[several firings are separate runs]');
{
  /*
   * The trigger includes a timestamp for exactly this reason: a routine that
   * fires hourly would otherwise look like one turn being re-claimed, and
   * `claimTurn` would refuse the second.
   */
  const second = claimForRoutine('r1');
  check('a second firing claims its own turn', Boolean(second));

  updateTurn(second.id, { state: 'completed' });
  check('two runs are recorded', listTurns(agent.id).length === 2,
    String(listTurns(agent.id).length));
}

console.log('\n[a failure is visible as failed]');
{
  /*
   * Absence is not an explanation. An operator asking why nothing happened
   * needs the reason, and a transcript does not survive a trimmed
   * conversation.
   */
  const turn = claimForRoutine('r2');
  updateTurn(turn.id, { state: 'failed', detail: 'the provider refused' });

  const failed = listTurns(agent.id).find((t) => t.state === 'failed');
  check('the failure is recorded', Boolean(failed));
  check('with a reason', failed?.detail === 'the provider refused', failed?.detail);
}

console.log('\n[scoping] turns belong to their conversation');
{
  const other = createAgentWithRoom({ presetId: 'openai', model: 'gpt-5.6-luna', name: 'Unrelated' });
  check('another agent has none', listTurns(other.id).length === 0);
  check('and the first still has its own', listTurns(agent.id).length === 3,
    String(listTurns(agent.id).length));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROUTINE-TURN TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROUTINE-TURN TEST PASSED\n');
