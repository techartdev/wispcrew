/**
 * room-create-test.mjs — the two ways a group comes into existence.
 *
 * Step 4 of docs/ROOMS.md. Two ways in, because the two situations are
 * genuinely different:
 *
 *  - From the plus button: a deliberate group, named, with at least two
 *    agents chosen up front.
 *  - From a conversation already in progress: adding a second agent to a
 *    one-to-one, which is the common case and was the worst behaved. The
 *    newcomer arrived with no idea what had been discussed, and the chat the
 *    user was in silently became something else.
 *
 * That second one asks a question rather than choosing a default, and this
 * suite pins why: "start fresh" keeps a private conversation private;
 * "bring the history" is what lets the joining agent see where things stand.
 * Neither is right for every case, and the original is untouched by either.
 *
 * Offline: store, plus a source read for the two UI paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgent,
  createConversation,
  createNodeCrypto,
  createRoom,
  initStore,
  loadTranscript,
  setHost,
  upsertTranscriptEntry,
} from '@wispcrew/runtime';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-room-create-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });
initStore(dir);

const host = createAgent({ name: 'Assistant' });
const guest = createAgent({ name: 'Reviewer' });
const chat = createConversation({ agentId: host.id, agentName: host.name });

for (let i = 0; i < 8; i++) {
  upsertTranscriptEntry(chat.id, {
    kind: 'message',
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    content: `line ${i}`,
    createdAt: Date.now() + i,
  });
}

console.log('\n[start fresh] the new room is empty, the old chat is not');
{
  const room = createRoom({
    title: 'Fresh',
    members: [{ id: host.id, name: host.name }, { id: guest.id, name: guest.name }],
  });

  check('the group starts empty', loadTranscript(room.id).length === 0,
    String(loadTranscript(room.id).length));
  // The load-bearing half: the user asked to start a group, not to lose the
  // conversation they were having.
  check('and the original is untouched', loadTranscript(chat.id).length === 8,
    String(loadTranscript(chat.id).length));
  check('the chat is still a direct chat', chat.kind === 'direct');
}

console.log('\n[bring the history] the group starts where the chat left off');
{
  const room = createRoom({
    title: 'Carried',
    members: [{ id: host.id, name: host.name }, { id: guest.id, name: guest.name }],
    fromConversationId: chat.id,
  });

  const carried = loadTranscript(room.id);
  // Eight messages plus the line marking the seam.
  check('everything said so far is there', carried.length === 9, String(carried.length));
  check('in order', carried[0]?.content === 'line 0' && carried[7]?.content === 'line 7');

  /*
   * The seam matters. Without it the room opens mid-conversation with no
   * explanation, and an agent added halfway through cannot tell that the
   * earlier part happened somewhere else, before it arrived.
   */
  const seam = carried[8];
  check('and a line says where it came from', seam?.kind === 'notice', seam?.kind);
  check('naming the conversation', /Continued from "Assistant"/.test(seam?.text ?? ''), seam?.text);
  check('and that it predates the room',
    /before this room existed/.test(seam?.text ?? ''), seam?.text);

  // COPIED, never moved.
  check('the original still has all of it', loadTranscript(chat.id).length === 8,
    String(loadTranscript(chat.id).length));
}

console.log('\n[still a group] both paths produce a real room');
{
  const rooms = ['Fresh', 'Carried'];
  for (const title of rooms) {
    const room = createRoom({
      title: `${title} again`,
      members: [{ id: host.id, name: host.name }, { id: guest.id, name: guest.name }],
    });
    check(`${title} again has an id of its own`, room.id.startsWith('room_'), room.id);
    check(`${title} again is a group`, room.kind === 'group');
  }
}

console.log('\n[refused] a group still needs two agents');
{
  let threw = '';
  try {
    createRoom({ title: 'Solo', members: [{ id: host.id, name: host.name }] });
  } catch (err) {
    threw = String(err.message ?? err);
  }
  check('one member is refused', /at least two/i.test(threw), threw || 'it was allowed');
}

console.log('\n[the plus button asks first] agent, or group');
{
  const app = read('apps/desktop/src/renderer/App.tsx');
  const panels = read('apps/desktop/src/renderer/Panels.tsx');

  check('there is a chooser', /NewChoicePanel/.test(panels));
  check('the plus button opens it', /onCreate=\{\(\) => setPanel\('new'\)\}/.test(app));
  // The shortcut and the button must not lead to two different places.
  check('and so does the keyboard shortcut', /setPanel\('new'\);/.test(app));

  /*
   * Offered but disabled below two agents, rather than hidden. Hiding it
   * would leave a new user unable to discover that groups exist at all.
   */
  check('a group needs two agents to be offered', /canGroup=\{agents\.length >= 2\}/.test(app));
  check('and says so when it cannot be', /Needs at least two agents/.test(panels));

  check('the group form exists', /NewGroupPanel/.test(panels));
  check('it asks for a name', /placeholder="e\.g\. Deploy review"/.test(panels));
  check('and for the room instructions', /Room instructions/.test(panels));
  // Said where it is typed, not only in the room afterwards.
  check('warning who will read them', /Visible to everyone in the room/.test(panels));

  /*
   * No model and no provider on this form. A room does not reconfigure the
   * agents in it — checked here because "the new group screen" is exactly
   * where a provider picker would feel natural to add.
   */
  const form = panels.slice(panels.indexOf('export function NewGroupPanel'),
    panels.indexOf('/* ------', panels.indexOf('export function NewGroupPanel')));
  check('and no model or provider anywhere on it',
    !/presetId|defaultModel|useProviderModels/.test(form));

  // Everyone in a room must live on one machine; the wrong choice is made
  // unavailable rather than discouraged.
  check('members must share a machine', /same machine/.test(panels));
}

console.log('\n[adding to a one-to-one asks] fresh, or with the history');
{
  const app = read('apps/desktop/src/renderer/App.tsx');
  const panels = read('apps/desktop/src/renderer/Panels.tsx');

  check('the room panel can split a chat', /onSplit/.test(panels));
  check('both answers are offered', /Bring the history/.test(panels) && /Start fresh/.test(panels));
  check('and each says what it means',
    /can see where\s+things stand/.test(panels) && /Nothing already said is shared/.test(panels));

  // The chat you are in stays as it is; a NEW room is what gets created.
  check('the chat is not converted in place',
    /This chat is between you and/.test(panels));
  check('the App creates a room rather than adding a member',
    /onSplit=\{\(id, bringHistory\) =>[\s\S]{0,400}actions\.createRoom/.test(app));
  check('and only carries the history when asked',
    /fromConversationId: bringHistory \? room\.id : undefined/.test(app));

  // A group adds members directly — the question only applies to a private
  // chat, where there is a conversation that could be handed over.
  check('a group still adds directly', /group \? onAdd\(a\.id\) : setJoining\(a\)/.test(panels));
}

console.log('\n[the CLI can do it too] not a crippled desktop');
{
  const commands = read('apps/daemon/src/cli-commands.ts');
  const cli = read('apps/daemon/src/cli.ts');

  check('rooms new exists', /'rooms new': roomsNew/.test(cli));
  check('and rooms greeting', /'rooms greeting': roomsGreeting/.test(cli));
  check('it takes --from', /--from/.test(commands));
  check('and --with-history', /--with-history/.test(commands));

  /*
   * The CLI cannot ask, so it takes the answer as a flag — and refuses to
   * infer it. Bringing a private conversation into a room with another
   * agent is not something to happen because an argument was omitted.
   */
  check('history is never inferred',
    /--with-history needs --from/.test(commands));
  check('and two agents are still the minimum',
    /A group needs at least two agents/.test(commands));
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`ROOM CREATE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM CREATE TEST PASSED\n');
