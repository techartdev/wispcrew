/**
 * turns-test.mjs — a turn is a durable record, not a boolean in memory.
 *
 * The failure this prevents is not a duplicated transcript: stable entry ids
 * already handle that. It is a duplicated SIDE EFFECT. A node receives
 * `@windows run the deploy`, starts, loses its connection, reconnects, sees
 * the same replicated message and runs it again.
 *
 * Offline: store only, no engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeTurns,
  addParticipant,
  claimTurn,
  createAgentWithRoom,
  createNodeCrypto,
  initStore,
  listTurns,
  loadTranscript,
  LOCAL_HUMAN_ID,
  releaseTurnsForNode,
  runRoomTurn,
  setHost,
  STALE_CLAIM_MS,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-turns-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'probe', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[claiming] one turn per message per agent');
{
  const first = claimTurn({ conversationId: 'c1', triggerEntryId: 'm1', agentId: 'a1' });
  check('the first claim succeeds', first !== null);
  check('and starts as claimed', first?.state === 'claimed', first?.state);
  check('recording which node holds it', first?.nodeId === 'probe');

  // The whole point: a replay must lose.
  const second = claimTurn({ conversationId: 'c1', triggerEntryId: 'm1', agentId: 'a1' });
  check('a second claim on the same message is refused', second === null);

  /*
   * But two AGENTS on one message is legitimate — `@windows and @linux both
   * look` is two turns, and refusing the second would break `@all`.
   */
  const other = claimTurn({ conversationId: 'c1', triggerEntryId: 'm1', agentId: 'a2' });
  check('a different agent may claim the same message', other !== null);

  // And the same agent on a different message.
  const later = claimTurn({ conversationId: 'c1', triggerEntryId: 'm2', agentId: 'a1' });
  check('the same agent may claim a later message', later !== null);
}

console.log('\n[finishing] a completed turn frees the message');
{
  const turn = claimTurn({ conversationId: 'c2', triggerEntryId: 'm9', agentId: 'a1' });
  updateTurn(turn.id, { state: 'completed' });

  const stored = listTurns('c2').find((t) => t.id === turn.id);
  check('the state is recorded', stored?.state === 'completed');
  check('with a finish time', typeof stored?.finishedAt === 'number');

  // A retry after completion is a new attempt, not a duplicate.
  const again = claimTurn({ conversationId: 'c2', triggerEntryId: 'm9', agentId: 'a1' });
  check('the message can be claimed again', again !== null);
}

console.log('\n[staleness] a claim nobody will finish does not block forever');
{
  const turn = claimTurn({ conversationId: 'c3', triggerEntryId: 'm5', agentId: 'a1' });

  // Simulate a process killed mid-turn: the claim survives, the process does
  // not. Without staleness that message is unreachable for good.
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'turns.json'), 'utf8'));
  const stale = all.find((t) => t.id === turn.id);
  stale.heartbeatAt = Date.now() - STALE_CLAIM_MS - 1000;
  fs.writeFileSync(path.join(dir, 'turns.json'), JSON.stringify(all));

  const reclaimed = claimTurn({ conversationId: 'c3', triggerEntryId: 'm5', agentId: 'a1' });
  check('a stale claim can be taken over', reclaimed !== null);
  check('and it is a new turn', reclaimed?.id !== turn.id);

  // A live claim is not stale, however long it has been running, as long as
  // it keeps saying so.
  const busy = claimTurn({ conversationId: 'c3', triggerEntryId: 'm6', agentId: 'a1' });
  updateTurn(busy.id, { state: 'running' });
  check('a heartbeating turn still blocks',
    claimTurn({ conversationId: 'c3', triggerEntryId: 'm6', agentId: 'a1' }) === null);
}

console.log('\n[shutdown] a stopping host releases its claims');
{
  claimTurn({ conversationId: 'c4', triggerEntryId: 'm7', agentId: 'a1' });
  const released = releaseTurnsForNode('probe');
  check('claims are released', released >= 1, String(released));

  /*
   * Otherwise the next start would refuse those messages for the whole
   * staleness window — fifteen minutes of a conversation that looks broken.
   */
  check('and the message is immediately available',
    claimTurn({ conversationId: 'c4', triggerEntryId: 'm7', agentId: 'a1' }) !== null);
}

console.log('\n[active] who is speaking right now');
{
  const turn = claimTurn({ conversationId: 'c5', triggerEntryId: 'm8', agentId: 'a1' });
  updateTurn(turn.id, { state: 'running' });

  check('the running turn is listed', activeTurns('c5').length === 1);
  updateTurn(turn.id, { state: 'completed' });
  check('and drops out when it finishes', activeTurns('c5').length === 0);
}

console.log('\n[end to end] a replayed message does not run twice');
{
  const agent = createAgentWithRoom({ name: 'Deployer' });

  let runs = 0;
  const run = async () => {
    runs++;
  };

  // The same entry id twice, which is exactly what a reconnect replays.
  const entryId = 'entry_replay';
  await runRoomTurn({
    conversationId: agent.id,
    text: 'deploy the thing',
    speakerId: LOCAL_HUMAN_ID,
    entryId,
    run,
  });
  await runRoomTurn({
    conversationId: agent.id,
    text: 'deploy the thing',
    speakerId: LOCAL_HUMAN_ID,
    entryId,
    run,
  });

  check('the agent ran once, not twice', runs === 1, String(runs));

  // And the transcript is not duplicated either, which stable ids handle.
  const said = loadTranscript(agent.id).filter(
    (e) => e.kind === 'message' && e.content === 'deploy the thing',
  );
  check('the message appears once', said.length === 1, String(said.length));
}

console.log('\n[failure] a failed turn records why');
{
  const agent = createAgentWithRoom({ name: 'Fragile' });
  await runRoomTurn({
    conversationId: agent.id,
    text: 'go',
    speakerId: LOCAL_HUMAN_ID,
    run: async () => {
      throw new Error('provider unreachable');
    },
  });

  const turn = listTurns(agent.id).pop();
  check('marked failed', turn?.state === 'failed', turn?.state);
  check('with the reason', /provider unreachable/.test(turn?.detail ?? ''), turn?.detail);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`TURNS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('TURNS TEST PASSED\n');
