/**
 * announce-test.mjs — a change the window is never told about.
 *
 * THE most-reported bug in this project, in every disguise: "I deleted it
 * and had to reload", "the agent stayed in the list", "the card never
 * appeared", "the routine wouldn't disappear".
 *
 * One cause each time. The desktop bridge emitted change events and the
 * DAEMON did not — while being the host that actually answers these calls,
 * because agent-scoped work is routed to whichever engine owns the agent.
 * So the store changed, the call returned successfully, and no window ever
 * heard.
 *
 * Fixing them one at a time was the mistake. This checks the class.
 *
 * Offline: reads both method tables.
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

const daemon = fs.readFileSync(path.join(repo, 'apps/daemon/src/methods.ts'), 'utf8');
const desktop = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');
const union = fs.readFileSync(path.join(repo, 'packages/shared/src/bridge.ts'), 'utf8');
const renderer = fs.readFileSync(
  path.join(repo, 'apps/desktop/src/renderer/useWispcrew.ts'), 'utf8',
);

/**
 * Every method that changes durable state, and the event it must produce.
 *
 * Listed by hand because "does this mutate?" is a judgement, not something
 * a regex can decide — but the list is short and adding to it is cheap.
 */
const MUTATIONS = [
  ['createAgent', 'agents-changed'],
  ['updateAgent', 'agents-changed'],
  ['deleteAgent', 'agents-changed'],
  ['duplicateAgent', 'agents-changed'],
  ['createRoutine', 'routines-changed'],
  ['updateRoutine', 'routines-changed'],
  ['deleteRoutine', 'routines-changed'],
  ['createSkill', 'skills-changed'],
  ['updateSkill', 'skills-changed'],
  ['deleteSkill', 'skills-changed'],
  ['revokeToolGrant', 'grants-changed'],
  ['addMcpServer', 'mcp-changed'],
  ['removeMcpServer', 'mcp-changed'],
];

console.log('\n[the daemon] every mutation announces');
{
  /*
   * Matched against the wrappers rather than a literal emit: each family is
   * routed through one `announce…` helper so a method added later is
   * missing its announcement VISIBLY at the call site, which is how all of
   * these came to be missing in the first place.
   */
  const WRAPPER = {
    'agents-changed': 'announceRoster',
    'routines-changed': 'announceRoutines',
    'skills-changed': 'announceSkills',
    'grants-changed': 'announceGrants',
    'mcp-changed': 'announceMcp',
  };

  for (const [method, event] of MUTATIONS) {
    const at = daemon.indexOf(`${method}:`);
    if (at === -1) {
      check(`daemon: ${method} exists`, false, 'method not found');
      continue;
    }

    // The handler body, to its next sibling at most.
    const body = daemon.slice(at, at + 420);
    check(`daemon: ${method} announces ${event}`,
      body.includes(WRAPPER[event]), body.split('\n')[0]);
  }
}

console.log('\n[the union] every announced event is declared');
{
  for (const event of new Set(MUTATIONS.map(([, e]) => e))) {
    check(`${event} is a known event`, union.includes(`'${event}'`));
  }
}

console.log('\n[the renderer] every event is handled');
{
  /*
   * An event nobody listens for is the same bug wearing a different hat:
   * the daemon does its part, the frame arrives, and nothing moves.
   */
  for (const event of new Set(MUTATIONS.map(([, e]) => e))) {
    check(`${event} updates the UI`, renderer.includes(`case '${event}'`));
  }
}

console.log('\n[the desktop] it announces the same things');
{
  // Both hosts serve the same clients, so a change made in either must look
  // identical from the outside.
  for (const event of new Set(MUTATIONS.map(([, e]) => e))) {
    check(`desktop emits ${event}`, desktop.includes(`'${event}'`));
  }
}

console.log('\n[the engine] what an AGENT changes is announced too');
{
  /*
   * The doors a CLIENT knocks on — the node's method table and the desktop
   * bridge — both announce what they change. Neither is involved when an
   * AGENT changes something itself, and that path kept being forgotten:
   *
   *  - a room's instructions, rewritten by `set_room_instructions`;
   *  - a room EVENT: a join, a departure, a handle following a rename;
   *  - a ROUTINE, from `propose_routine` or `schedule_follow_up`.
   *
   * The last was reported as "I told the agent to create a cron, nothing
   * appeared in routines… I had to do reload and then the routine
   * appeared". It was on disk and the agent had said so; the Scheduled list
   * simply never heard.
   */
  const src = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

  const schedule = src('packages/runtime/src/schedule-host.ts');
  check('both self-scheduling paths announce',
    (schedule.match(/announceRoutines\(\)/g) ?? []).length >= 2,
    'one of the two creation paths is still silent');

  const transcript = src('packages/runtime/src/transcript.ts');
  check('and the announcement reads the list itself',
    /export function announceRoutines[\s\S]{0,300}store\.listRoutines\(\)/.test(transcript),
    'a caller-supplied list would be a second door onto one fact');

  const engine = src('packages/runtime/src/engine.ts');
  check('rewritten room instructions are announced', /announceRooms\(/.test(engine));

  const conversations = src('packages/runtime/src/conversations.ts');
  check('and room events are pushed, not merely written',
    /pushTranscript\(conversationId, entry\)/.test(conversations));
}

console.log('');
if (failures) {
  console.error(`ANNOUNCE TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('ANNOUNCE TEST PASSED\n');
