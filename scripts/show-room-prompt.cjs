/**
 * show-room-prompt.cjs — the system prompt an agent actually receives in a
 * room, read from the real profile.
 *
 *   node scripts/show-room-prompt.cjs "<room title>" "<agent name>"
 *
 * Exists because "the prompt renders a greeting it is given" and "anything
 * gives it one" are different claims, and only the second one matters live.
 */
const {
  setHost,
  createNodeCrypto,
  initStore,
  listConversations,
  listAgents,
} = require('../packages/runtime/dist/index.js');
const { defaultSystemPrompt } = require('../packages/core/dist/index.js');
const os = require('node:os');
const path = require('node:path');

const dir = path.join(os.homedir(), '.wispcrew');
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'show', crypto: createNodeCrypto(dir) });
initStore(dir);

const [roomWanted, agentWanted] = process.argv.slice(2);

const room = listConversations().find(
  (r) => r.id === roomWanted || r.title.toLowerCase() === String(roomWanted).toLowerCase(),
);
if (!room) {
  console.error(`no room "${roomWanted}". Have: ${listConversations().map((r) => r.title).join(', ')}`);
  process.exit(1);
}

const agents = listAgents();
const self = agents.find((a) => a.name.toLowerCase() === String(agentWanted).toLowerCase());

console.log(`room    ${room.title}  (${room.id})`);
console.log(`kind    ${room.kind}`);
console.log(`greeting ${JSON.stringify(room.greeting)}`);
console.log('');

const participants = (room.participants ?? []).map((p) =>
  p.kind === 'human'
    ? { kind: 'human', name: p.name, via: 'a person, at the app' }
    : {
        kind: 'agent',
        name: agents.find((a) => a.id === p.id)?.name ?? p.handle,
        handle: p.handle,
        via: 'an agent on this machine',
      },
);

const selfHandle = (room.participants ?? []).find((p) => p.id === self?.id)?.handle;

console.log(
  defaultSystemPrompt({
    agentName: self?.name,
    handle: selfHandle,
    persistent: true,
    room: {
      title: room.kind === 'group' ? room.title : undefined,
      greeting: room.greeting,
      mode: room.mode,
      participants,
    },
  }),
);
