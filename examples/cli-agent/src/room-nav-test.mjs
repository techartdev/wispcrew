/**
 * room-nav-test.mjs — the room stops being its first agent, on screen.
 *
 * Step 3 of docs/ROOMS.md. Steps 1 and 2 changed the data; this is the step
 * where the interface stops pretending a room is an agent, and it is the one
 * a suite can most easily miss — every defect it covers typechecked cleanly
 * and was visible only by launching the app and looking.
 *
 * Four things, each of which was actually wrong:
 *
 *  1. The sidebar listed AGENTS, showing a shared room as decoration on
 *     whichever agent it was rooted at. A group with an id of its own would
 *     have had no row at all — created, saved, and invisible.
 *  2. The header showed `selected.model`, so a conversation between agents
 *     on three different models announced one of them, picked by nothing
 *     but who was listed first.
 *  3. Configure opened that same agent. A member's cog had to SELECT the
 *     agent first, throwing the user out of the room they were fixing it
 *     from.
 *  4. Assistant messages carried no author at all, so every reply was
 *     displayed under one name.
 *
 * Offline: reads source, plus the store for the author round trip.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const sidebar = read('apps/desktop/src/renderer/Sidebar.tsx');
const app = read('apps/desktop/src/renderer/App.tsx');
const chat = read('apps/desktop/src/renderer/Chat.tsx');
const hook = read('apps/desktop/src/renderer/useWispcrew.ts');
const engine = read('packages/runtime/src/engine.ts');
const css = read('apps/desktop/src/renderer/styles.css');

console.log('\n[sidebar] rows are conversations, not agents');
{
  check('it takes the conversation list', /conversations: ConversationRecord\[\]/.test(sidebar));
  check('and the App hands it over', /conversations=\{state\.conversations\}/.test(app));

  /*
   * The two props that only made sense while a room hung off an agent. If
   * either comes back, a room is being described by one of its members
   * again.
   */
  check('no per-agent room decoration survives', !/companions/.test(sidebar));
  check('nor a map of room titles by agent id', !/roomTitles/.test(sidebar));
  check('and the App builds neither', !/companions|roomTitles/.test(app));

  // Selecting a row must mean selecting a CONVERSATION; a group has no agent
  // whose id could stand in for it.
  check('selection is by conversation', /selectConversation/.test(hook), 'still selectAgent');
  check('and the sidebar is wired to it', /onSelect=\{actions\.selectConversation\}/.test(app));

  // A group's row is recognisable without reading: stacked faces.
  check('a group stacks its members\u2019 avatars', /AvatarStack seeds=\{row\.seeds\}/.test(sidebar));
}

console.log('\n[classes] every class the sidebar renders is styled');
{
  const rendered = new Set();
  for (const m of sidebar.matchAll(/className="([^"{]+)"/g)) {
    for (const c of m[1].split(/\s+/).filter(Boolean)) rendered.add(c);
  }
  for (const m of sidebar.matchAll(/className=\{`([a-z-]+)\s/g)) rendered.add(m[1]);

  check('it renders classes at all', rendered.size >= 6, `${rendered.size} found`);
  let missing = 0;
  for (const cls of [...rendered].sort()) {
    if (!css.includes(`.${cls}`)) {
      missing++;
      console.error(`  FAIL .${cls} is rendered but not styled`);
    }
  }
  failures += missing;
  if (missing === 0) console.log(`  ok   all ${rendered.size} classes styled`);
}

console.log('\n[header] a room has no model, so it shows none');
{
  /*
   * The whole point. A room does not hold a model or a provider, so the
   * header cannot borrow one from a member — it says who is in the room
   * instead, which is a fact it actually has.
   */
  check('the model line is guarded by "not a room"', /isRoom \?/.test(app));
  check('a room reports its members and mode', /\{roomMembers\.length\} agents/.test(app));
  check('and the title comes from the subject, not an agent',
    /<strong>\{subject\?\.name \?\? 'WispCrew'\}<\/strong>/.test(app));

  // Configure means something different in each place, so it goes somewhere
  // different: the agent's settings, or the room's.
  check('Configure branches on which it is', /isRoom \? 'Room settings' : 'Configure'/.test(app));
}

console.log('\n[configure] a member\u2019s cog does not move you');
{
  /*
   * It used to select the agent and then open the panel, which walked the
   * user out of the room — and the room is where somebody notices an agent
   * is misbehaving, so it is where fixing it should begin.
   */
  check('configuring is its own state', /configuringId/.test(app));
  check('and does not change the selection',
    !/onConfigure=\{\(id\) => \{ actions\.select/.test(app));
  check('the panel edits what is being configured', /agent=\{configuring\}/.test(app));
}

console.log('\n[attribution] a reply wears its own name');
{
  /*
   * `authorId` had been on the entry type since rooms existed and nothing
   * ever wrote it on an assistant message or read it back. Every reply in a
   * shared room was therefore labelled with whichever agent the room was
   * rooted at.
   */
  check('the engine records who spoke', /authorId: agentId/.test(engine));
  check('and the chat reads it back', /entry\.authorId/.test(chat));
  check('through a named helper', /const authorOf/.test(chat));
  check('which the transcript actually calls', /\{authorOf\(entry\)\}/.test(chat));

  /*
   * The fallback matters as much as the lookup. With several agents present
   * and no author recorded, naming the ROOM would claim the room spoke —
   * which is how "Deploy review" ended up above a reply written by an agent.
   */
  check('an unknown author in a group is not given the room\u2019s name',
    /members\.length > 1 \? 'Agent'/.test(chat));
  check('but a room of one is unambiguous', /members\.length === 1/.test(chat));

  // A person's door is worth naming; a reply typed on a train reads
  // differently from one typed at the desk, and both are "You".
  check('a message from elsewhere says so', /You · via/.test(chat));
}

console.log('\n[members] passed for every conversation, not only shared ones');
{
  /*
   * They are how a message finds its author's name, so a list that was
   * empty for a one-to-one would have left those messages nameless. The
   * "do not offer a mention of the only participant" rule moved into the
   * Chat, beside the menu it governs.
   */
  check('the App always passes members', /members=\{roomMembers\}/.test(app));
  check('and the mention menu holds the gate', /members\.length < 2\) return \[\]/.test(chat));
}

console.log('\n[selection] the app opens on the row at the top');
{
  /*
   * The selection was repaired inside the `agents-changed` handler against
   * the AGENT roster. Wrong twice: a group is not in that roster, so any
   * agent change could throw the user out of a room; and at startup the
   * roster event can arrive before the initial load, where an empty
   * selection was read as "deleted" and replaced with the first agent — so
   * the app opened on a row in the middle of the sidebar.
   */
  check('one door repairs the selection', /const applyConversations/.test(hook));
  check('checked against conversations', /list\.some\(\(c\) => c\.id === prev\)/.test(hook));
  check('and agents-changed no longer touches it',
    !/case 'agents-changed':[\s\S]{0,400}setSelectedId/.test(hook));

  // Every list of rooms arrives through it, including the pushed one.
  check('the initial load uses it', /applyConversations\(arr<ConversationRecord>\(cv\)\)/.test(hook));
  check('and so does rooms-changed', /applyConversations\(event\.conversations\)/.test(hook));
}

console.log('\n[ordering] the list moves when somebody talks');
{
  /*
   * Neither `agent.updatedAt` nor `conversation.updatedAt` moved when a
   * message arrived — both recorded only that something had been
   * CONFIGURED. So the sidebar was ordered by whichever agent you last
   * edited the settings of, and the conversation you were actually talking
   * in drifted down the list.
   */
  const roomTurn = read('packages/runtime/src/room-turn.ts');
  check('a message touches its conversation', /updateConversation\(conversation\.id, \{\}\)/.test(roomTurn));
  // Once per human message, not once per streamed token: a write per delta
  // would be thousands of file writes in one reply.
  check('once per message, not per token', /not per streamed token/.test(roomTurn));

  check('and the sidebar sorts by that one clock',
    /updatedAt: conversation\.updatedAt/.test(sidebar));
}

console.log('');
if (failures) {
  console.error(`ROOM NAV TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ROOM NAV TEST PASSED\n');
