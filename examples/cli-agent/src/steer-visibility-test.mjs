/**
 * steer-visibility-test — a queued message must be visible while it waits.
 *
 * ## What the user saw
 *
 * Typing mid-turn appeared to send an ordinary message. No pending item
 * under the composer, nothing to edit or cancel, no sign the text had
 * joined the running turn. Reported three times as "it directly sent it"
 * and "looks the same", and each report was correct about the SYMPTOM while
 * the mechanism underneath was working.
 *
 * The queue UI has existed all along: an editable row below the composer
 * reading "goes to the agent after the running step finishes". Exactly the
 * behaviour of a normal IDE. It was simply never drawn.
 *
 * ## The fault
 *
 * A steering queue lives on an `Agent` session, keyed `agent_…`. The
 * renderer keys everything it displays by the conversation it has open,
 * which in a room is `room_…`. Four emit sites used the agent's id and the
 * renderer looked up the room's, so the lookup missed every time.
 *
 * Worse in the other direction: `sendToRoom` — the path the composer
 * actually uses — called `steerSession(conversationId)`, which matches no
 * session for a room, returned false, and fell through to a full turn.
 * Its comment described that as correct behaviour, which is how it survived.
 *
 * In a one-to-one chat both ids are the same, so none of this was visible.
 *
 * Same agent-id-versus-room-id seam as 6bb601c and 9ac4b8f. Third time in
 * one evening, so this pins the shape rather than the instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const bridge = fs.readFileSync(path.join(root, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'packages/runtime/src/engine.ts'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/useWispcrew.ts'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/Chat.tsx'), 'utf8');

console.log('[1] the renderer keys the queue by the open conversation');
{
  /*
   * Not an implementation detail to be matched loosely: this is the key
   * every emit site must agree with, so it is asserted first and the rest
   * are checked against it.
   */
  check(
    'it reads by selectedId',
    /queuedSteer: \(selectedId \? queuedSteer\[selectedId\]/.test(hook),
    'the renderer changed how it looks the queue up',
  );
  check(
    'and stores what an event carries',
    /case 'steer-queued':[\s\S]{0,160}?\[event\.agentId\]: event\.queued/.test(hook),
  );
}

console.log('\n[2] a room resolves to the member that is running');
{
  check('the bridge has one resolver', /function sessionTargetFor\(conversationId: string\)/.test(bridge));
  check(
    'a conversation with its own session is used directly',
    /if \(isRunning\(conversationId\)\) return conversationId;/.test(bridge),
  );
  check(
    'otherwise the running member is found',
    /agentsIn\(room\)\.find\(\(member\) => isRunning\(member\.id\)\)/.test(bridge),
  );

  /*
   * Returning undefined when nobody is running is the case the old comment
   * described. It is right — there is no loop to steer into — and the
   * caller must then send an ordinary prompt rather than swallow the text.
   */
  check('and nothing when no member is busy', /return busy\?\.id;/.test(bridge));
}

console.log('\n[3] every steer path resolves before touching a session');
{
  /*
   * `steerSession` takes an AGENT id. Passing a room id silently returns
   * false, which reads as "no turn running" and starts a second turn — the
   * exact failure being fixed. So no call may pass a raw conversation id.
   */
  const rawCalls = [...bridge.matchAll(/steerSession\((\w+)/g)].map((m) => m[1]);
  check(
    'no steerSession call takes a raw conversation id',
    rawCalls.every((arg) => arg === 'steerTarget'),
    JSON.stringify(rawCalls),
  );

  const rawReads = [...bridge.matchAll(/queuedSteer\((\w+)\)/g)].map((m) => m[1]);
  check(
    'no queue read takes one either',
    rawReads.every((arg) => arg === 'steerTarget' || arg === 'target'),
    JSON.stringify(rawReads),
  );

  check(
    'sendToRoom resolves first',
    /const steerTarget = sessionTargetFor\(conversationId\);/.test(bridge),
    'the composer path still keys on the room',
  );
}

console.log('\n[4] events are announced against the conversation on screen');
{
  /*
   * The queue lives on the agent; the announcement must name the room, or
   * the renderer cannot match it. Both halves are load-bearing and they are
   * deliberately different ids.
   */
  check(
    'the engine announces the conversation',
    /emitEngineEvent\(\{ type: 'steer-queued', agentId: outputId, queued: queuedSteer\(agentId\) \}\)/.test(engine),
    'engine still announces the agent id',
  );

  const bridgeEmits = [...bridge.matchAll(/emitEvent\(\{[\s\S]{0,200}?type: 'steer-queued'[\s\S]{0,200}?\}\)/g)].map(
    (m) => m[0].replace(/\s+/g, ' '),
  );
  check('every bridge emit carries an id', bridgeEmits.length >= 3, `${bridgeEmits.length} sites`);
  check(
    'and none announces a resolved session id',
    bridgeEmits.every((e) => /agentId(?!: steerTarget)/.test(e)),
    JSON.stringify(bridgeEmits.filter((e) => /agentId: steerTarget/.test(e))),
  );
}

console.log('\n[5] the pending message is rendered, editable and cancellable');
{
  /*
   * The whole point of the queue: the user can see the message waiting,
   * change their mind after a tool result arrives, or drop it entirely.
   * Without this the mechanism is invisible and indistinguishable from
   * having sent an ordinary prompt.
   */
  check('a queue renders when it has items', /\{queuedSteer\.length > 0 && \(/.test(chat));
  check('each item is editable', /className="steer-text"[\s\S]{0,300}?onChange=/.test(chat));
  check('and removable', /onEditQueuedSteer\(queuedSteer\.filter/.test(chat));
  /*
   * Matched on the load-bearing words rather than the whole sentence. The
   * first version pinned the exact copy and failed the moment the wording
   * improved — a test that forbids editing the text it checks.
   */
  check('the hint says when it will be sent', /goes in when/.test(chat));
}

console.log('\n[6] the queue behaves like a queue');
{
  /*
   * Three faults the user found by using it, all of which made a working
   * mechanism look broken:
   *
   *   "i saw the steer twice"  — the caller's copy was removed from the
   *   file but the renderer was never told, so it kept showing it and then
   *   drew the injected copy as well.
   *
   *   "i simply clicked the x to remove this waiting message" — the row
   *   stayed after the message had already gone to the model, still
   *   offering to edit text that was no longer editable.
   *
   *   "to steer by send now ... none of this works" — the send button was
   *   a no-op. It could never be anything else: injecting mid-step leaves a
   *   tool call unanswered and the provider rejects the request. The button
   *   promised an immediacy the protocol does not have.
   *
   * Comments are stripped before matching. Two assertions in this file have
   * already broken by measuring distance from a landmark, and a test that
   * fails when prose grows teaches people to delete the prose.
   */
  const code = engine.replace(/\/\*[\s\S]*?\*\//g, '');
  const shared = fs.readFileSync(path.join(root, 'packages/shared/src/bridge.ts'), 'utf8');

  check(
    'a withdrawal has an event of its own',
    /'transcript-removed'; agentId: string; entryId: string/.test(shared),
  );
  check(
    'the engine announces one when it steers',
    /emitEngineEvent\(\{ type: 'transcript-removed', agentId: outputId, entryId: opts\.triggerEntryId \}\)/.test(code),
  );
  check(
    'and only when an entry was really removed',
    /if \(opts\?\.triggerEntryId && store\.removeTranscriptEntry\(/.test(code),
    'announcing a removal that did not happen would drop the wrong message',
  );
  check(
    'the renderer acts on it',
    /case 'transcript-removed':[\s\S]{0,240}?filter\(\(e\) => e\.id !== event\.entryId\)/.test(
      hook.replace(/\/\*[\s\S]*?\*\//g, ''),
    ),
  );

  /*
   * `drainSteer` empties the queue on the session, but nothing told the
   * renderer, so the row outlived the message it represented.
   */
  const applied = code.slice(code.indexOf("e.type === 'steer_applied'"));
  check(
    'the pending row clears when the message lands',
    /type: 'steer-queued'/.test(applied.slice(0, applied.indexOf('tool_call_start'))),
    'the row must not outlive the message it represents',
  );

  check('no button promises to send it sooner', !/className="steer-send"/.test(chat));
  check('the hint says when it will go', /goes in when/.test(chat));
  check(
    'editing and cancelling still work',
    /className="steer-text"/.test(chat) && /className="steer-remove"/.test(chat),
    'the queue is the user\'s until the model reads it',
  );
}

console.log('');
if (failures) {
  console.log(`STEER-VISIBILITY TEST FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('STEER-VISIBILITY TEST PASSED');
