/**
 * room-dispatch-test.mjs — a room's agents run where they live.
 *
 * An agent belongs to exactly one node: its workspace, its files and its
 * provider key are there, so running it anywhere else would give it none of
 * them. `runRoomTurn` called `runPrompt` for every speaker, which is right
 * when everything is local and wrong the moment it is not.
 *
 * The model is client-relayed, and its limitation is deliberate: a
 * multi-node room needs a connected client. Nodes do not know about each
 * other, so nothing else can carry the traffic. Saying so is better than
 * claiming a coordinator that does not exist.
 *
 * Offline: no sockets, no engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canReachOtherNodes,
  createAgentWithRoom,
  createNodeCrypto,
  initStore,
  listTurns,
  loadTranscript,
  LOCAL_HUMAN_ID,
  addParticipant,
  placeSpeakers,
  runRoomTurn,
  setHost,
  setRemoteRunner,
  updateAgent,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-disp-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'here', crypto: createNodeCrypto(dir) });
initStore(dir);

const local = createAgentWithRoom({ name: 'Local' });
const windows = createAgentWithRoom({ name: 'Windows' });
const linux = createAgentWithRoom({ name: 'Linux' });

// Two of them live elsewhere.
updateAgent(windows.id, { nodeId: 'gaming-pc' });
updateAgent(linux.id, { nodeId: 'vps' });

const room = local.id;
addParticipant(room, { kind: 'agent', id: windows.id, handle: 'windows' }, LOCAL_HUMAN_ID, 'You');
addParticipant(room, { kind: 'agent', id: linux.id, handle: 'linux' }, LOCAL_HUMAN_ID, 'You');

const speakers = [
  { kind: 'agent', id: local.id, handle: 'local' },
  { kind: 'agent', id: windows.id, handle: 'windows' },
  { kind: 'agent', id: linux.id, handle: 'linux' },
];

console.log('\n[no relay] a daemon cannot reach other machines, and says so');
{
  setRemoteRunner(null);
  check('cross-node is unavailable', canReachOtherNodes() === false);

  const placement = placeSpeakers(speakers);
  check('the local agent still runs', placement.local.length === 1, String(placement.local.length));
  /*
   * Reported, not silently skipped. A message that reaches nobody and says
   * nothing is indistinguishable from a broken application.
   */
  check('the others are unreachable', placement.unreachable.length === 2,
    String(placement.unreachable.length));
  check('and none are treated as remote', placement.remote.length === 0);
}

console.log('\n[with a relay] agents are grouped by their node');
{
  setRemoteRunner(async () => {});
  check('cross-node is available', canReachOtherNodes() === true);

  const placement = placeSpeakers(speakers);
  check('one runs locally', placement.local.length === 1);
  check('two nodes are addressed', placement.remote.length === 2, String(placement.remote.length));
  check('nothing is unreachable', placement.unreachable.length === 0);

  const nodes = placement.remote.map((r) => r.nodeId).sort();
  check('the right machines', nodes.join(',') === 'gaming-pc,vps', nodes.join(','));
}

console.log('\n[grouping] several agents on one node are batched');
{
  updateAgent(linux.id, { nodeId: 'gaming-pc' });
  const placement = placeSpeakers(speakers);

  check('one node, two agents', placement.remote.length === 1 && placement.remote[0].agents.length === 2,
    JSON.stringify(placement.remote.map((r) => [r.nodeId, r.agents.length])));

  updateAgent(linux.id, { nodeId: 'vps' });
}

console.log('\n[dispatch] a remote agent is relayed, not run here');
{
  const relayed = [];
  setRemoteRunner(async (nodeId, agentId, text) => {
    relayed.push({ nodeId, agentId, text });
  });

  const ranLocally = [];
  await runRoomTurn({
    conversationId: room,
    text: '@windows check the build',
    speakerId: LOCAL_HUMAN_ID,
    // Not passed: the injected `run` would keep everything local, which is
    // the seam for avoiding a provider call rather than modelling placement.
  });

  check('it was relayed', relayed.length === 1, JSON.stringify(relayed));
  check('to the right machine', relayed[0]?.nodeId === 'gaming-pc', relayed[0]?.nodeId);
  check('with the right agent', relayed[0]?.agentId === windows.id);
  check('and did not run here', ranLocally.length === 0);

  // The claim lives where the room does, so the client cannot relay twice.
  const turns = listTurns(room);
  check('a turn was recorded', turns.length >= 1);
  check('and completed', turns.at(-1)?.state === 'completed', turns.at(-1)?.state);
}

console.log('\n[unreachable] a sleeping machine is named, not swallowed');
{
  setRemoteRunner(async () => {
    throw new Error('not connected');
  });

  const before = loadTranscript(room).length;
  await runRoomTurn({
    conversationId: room,
    text: '@linux run the tests',
    speakerId: LOCAL_HUMAN_ID,
  });

  const added = loadTranscript(room).slice(before);
  const notice = added.find((e) => e.kind === 'notice' && e.level === 'error');

  check('the failure is recorded', Boolean(notice), JSON.stringify(added.map((e) => e.kind)));
  // Naming the agent is what makes it actionable.
  check('naming the agent', /@linux/.test(notice?.text ?? ''), notice?.text);

  /*
   * Find the turn by AGENT, not by position.
   *
   * Finished turns are stored newest-first, so `.at(-1)` is the oldest — an
   * assertion that happened to pass while the list was short and would have
   * misled later.
   */
  const linuxTurn = listTurns(room).find((t) => t.agentId === linux.id);
  check('and its turn is marked failed', linuxTurn?.state === 'failed', linuxTurn?.state);
  check('with the reason', /not connected/.test(linuxTurn?.detail ?? ''), linuxTurn?.detail);
}

console.log('\n[no relay installed] the same message is explicable');
{
  setRemoteRunner(null);

  const before = loadTranscript(room).length;
  await runRoomTurn({
    conversationId: room,
    text: '@windows are you there?',
    speakerId: LOCAL_HUMAN_ID,
  });

  const notice = loadTranscript(room).slice(before).find((e) => e.kind === 'notice');
  check('it says the machine is not connected',
    /another machine, which is not connected/.test(notice?.text ?? ''), notice?.text);
}

setRemoteRunner(null);
fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM-DISPATCH TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM-DISPATCH TEST PASSED\n');
