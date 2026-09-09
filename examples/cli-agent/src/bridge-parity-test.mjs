/**
 * bridge-parity-test.mjs — the two method tables, and the routing table,
 * must agree about the one engine underneath them.
 *
 * This bug class has now surfaced five times, and every single instance was
 * found by a person reading code:
 *
 *   - `sendToRoom` was missing from the routing table, so a message to an
 *     agent on another machine ran against the local daemon. It succeeded,
 *     wrote nothing, and returned. Reported as "I type and nothing happens".
 *   - `createAgent` routed by an agent id it did not have, so an agent
 *     assigned to a VPS was created on this machine instead.
 *   - `deleteAgent` did its cleanup only in the desktop bridge, while the
 *     daemon — which is normally what runs — called the bare store function.
 *     A revoked permission outlived the agent it belonged to.
 *   - `revokeToolGrant` revoked from the local store for a remote agent, so
 *     the row on the node survived the user pressing Revoke.
 *   - `updateRoutine` and friends edited the local copy of a routine that
 *     fires somewhere else.
 *
 * Every one is the same shape: a hand-maintained list that somebody has to
 * remember to add to. This test is the thing that remembers.
 *
 * It is deliberately STRUCTURAL — it parses the sources rather than running
 * an engine — because the fault is always a name missing from a list, and a
 * behavioural test would need a second machine to show it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

const bridgeSrc = read('packages/shared/src/bridge.ts');
const hostSrc = read('apps/desktop/src/main/bridge-host.ts');
const methodsSrc = read('apps/daemon/src/methods.ts');
const linksSrc = read('apps/desktop/src/main/node-links.ts');
const preloadSrc = read('apps/desktop/src/preload/preload.ts');

/** Method names declared on the WispBridge interface. */
function interfaceMethods() {
  const start = bridgeSrc.indexOf('export interface WispBridge');
  const body = bridgeSrc.slice(start);
  return new Set([...body.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]));
}

/** Names inside a `new Set([...])` assigned to `name`. */
function setEntries(src, name) {
  const at = src.indexOf(`const ${name}`);
  if (at === -1) return new Set();
  const open = src.indexOf('[', at);
  const close = src.indexOf(']);', open);
  return new Set([...src.slice(open, close).matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
}

const iface = interfaceMethods();
const host = new Set([...hostSrc.matchAll(/handle\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
const daemon = new Set([...methodsSrc.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const preload = new Set([...preloadSrc.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const agentScoped = setEntries(linksSrc, 'AGENT_SCOPED');
const routineScoped = setEntries(linksSrc, 'ROUTINE_SCOPED');
const localOnly = setEntries(hostSrc, 'LOCAL_ONLY');

console.log(
  `\ninterface ${iface.size} · bridge ${host.size} · daemon ${daemon.size} · ` +
    `preload ${preload.size} · routed ${agentScoped.size + routineScoped.size}`,
);

console.log('\n[1] every declared method is reachable from the renderer');
{
  // `onEvent` is a subscription, not a call, and has no ipc handler.
  const exempt = new Set(['onEvent']);
  const missing = [...iface].filter((m) => !exempt.has(m) && !preload.has(m));
  check('all exposed in preload', missing.length === 0, missing.join(', '));
}

console.log('\n[2] every declared method is implemented somewhere');
{
  const exempt = new Set(['onEvent']);
  const nowhere = [...iface].filter((m) => !exempt.has(m) && !host.has(m) && !daemon.has(m));
  check('none unimplemented', nowhere.length === 0, nowhere.join(', '));
}

console.log('\n[3] anything the desktop forwards, the daemon can answer');
{
  /*
   * A method the desktop does NOT implement itself is forwarded to whatever
   * engine is attached. If the daemon has no such method the call fails with
   * "unknown method" the moment a daemon exists — which is the normal case.
   */
  const forwarded = [...iface].filter(
    (m) => m !== 'onEvent' && !host.has(m) && !localOnly.has(m),
  );
  const cannot = forwarded.filter((m) => !daemon.has(m));
  check('no forwarded method is missing from the node', cannot.length === 0, cannot.join(', '));
}

console.log('\n[4] a call about one agent reaches the machine that owns it');
{
  /*
   * THE ONE THAT KEEPS BREAKING.
   *
   * Any method whose first parameter names an agent or a conversation is
   * about work that happens on that agent's machine. If it is not routed,
   * it silently runs against the local store for an agent that lives
   * somewhere else.
   *
   * A new method with this shape must be added to AGENT_SCOPED, or listed
   * below with the reason it is genuinely local.
   */
  const exempt = new Map([
    // Takes an OPTIONAL agent id; with none it means "all of them", which is
    // a client-side view assembled from every node.
    ['listRoutines', 'optional agent id, aggregated client-side'],
    // Answered by gathering from every node, not by routing to one.
    ['listToolGrants', 'aggregated across nodes in the handler'],
    // Resolves an approval THIS process is waiting on; the id is a request,
    // not an agent.
    ['resolveApproval', 'requestId, settled in the asking process'],
  ]);

  const idFirst = [...bridgeSrc.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\((.*?)\)\s*:/gm)]
    .map(([, name, params]) => {
      const first = (params.split(',')[0] ?? '').trim();
      return { name, param: (first.split(':')[0] ?? '').trim().replace('?', '') };
    })
    .filter(({ param }) => /^(agentId|conversationId|roomId)$/.test(param));

  const unrouted = idFirst.filter(
    ({ name }) => !agentScoped.has(name) && !routineScoped.has(name) && !exempt.has(name),
  );

  check(
    'every agent- or conversation-scoped call is routed',
    unrouted.length === 0,
    unrouted.length
      ? `not routed: ${unrouted.map((u) => `${u.name}(${u.param})`).join(', ')}\n` +
        '       Add to AGENT_SCOPED in node-links.ts, or to the exempt list here with a reason.'
      : '',
  );
}

console.log('\n[5] the routing tables name only methods that exist');
{
  /*
   * Checked against the NODE's method table, not the bridge interface.
   *
   * The routing table covers more than the renderer uses: `listTurns`,
   * `cancelTurn`, `stopAgent` and `clearTranscript` are real methods the
   * `wispcrew` CLI calls over the same protocol, and they are agent-scoped
   * for exactly the same reason. Testing them against `WispBridge` reported
   * four false positives on this test's first run.
   *
   * What would be a genuine fault is a routed name that no engine
   * implements: the call is forwarded to a node that answers "unknown
   * method", or worse, silently runs locally.
   */
  const bogus = [...agentScoped, ...routineScoped].filter(
    (m) => !iface.has(m) && !daemon.has(m),
  );
  check('no routed name is stale', bogus.length === 0, bogus.join(', '));
}

console.log('\n[6] routine-scoped methods take a routine id, not an agent id');
{
  /*
   * These are routed by resolving the routine to its owner, so putting one
   * in AGENT_SCOPED instead would route by a routine id read as an agent id
   * — which resolves to no node, and silently runs locally.
   */
  const overlap = [...routineScoped].filter((m) => agentScoped.has(m));
  check('the two routing sets are disjoint', overlap.length === 0, overlap.join(', '));
}


/*
 * [7] A method that accepts fewer arguments than the interface declares.
 *
 * This is the quietest failure in the whole seam. JavaScript discards extra
 * arguments in silence, so a daemon method with a short parameter list keeps
 * answering, keeps type-checking (the table is typed `never`), and simply
 * loses whatever the caller passed last. Found in the wild: `sendToRoom` and
 * `sendPrompt` both omitted `attachmentPaths`, so with a daemon attached --
 * the ordinary case -- every pasted screenshot was written to disk, shown in
 * the composer, then dropped on the way to the model. The user saw a
 * thumbnail before sending and no image after it.
 *
 * Counting parameters is crude, and it is exactly what nobody rechecks by
 * hand when adding one to an interface.
 */
console.log('\n[7] no daemon method silently drops a declared argument');
{
  const splitTop = (s) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if ('([{<'.includes(ch)) depth++;
      if (')]}>'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };

  /** The parameter list of the call whose '(' is at or after `from`. */
  const paramsAt = (src, from) => {
    const open = src.indexOf('(', from);
    if (open === -1) return null;
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (!depth) return src.slice(open + 1, j);
      }
    }
    return null;
  };

  const ifaceBody = bridgeSrc.slice(bridgeSrc.indexOf('export interface WispBridge'));
  const declared = new Map();
  for (const m of ifaceBody.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9_]*)\s*\(/gm)) {
    const p = paramsAt(ifaceBody, m.index + m[0].length - 1);
    if (p !== null) declared.set(m[1], splitTop(p));
  }

  const implemented = new Map();
  for (const m of methodsSrc.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\s*:\s*(?:async\s*)?\(/gm)) {
    const p = paramsAt(methodsSrc, m.index + m[0].length - 1);
    if (p !== null) implemented.set(m[1], splitTop(p));
  }

  /*
   * Refusals, not implementations. These need a browser or this machine's
   * own credential store, so on a remote node they throw by design and have
   * no use for the argument.
   */
  const refuses = new Set(['oauthSignIn', 'oauthImportFromCli']);

  /*
   * `getTranscript(agentId, limit?)`: the runtime's `loadTranscript` takes no
   * limit, so no daemon can honour it. Listed here so the count passes while
   * naming the gap rather than hiding it -- the honest fix is to drop
   * `limit` from the interface or implement it in the store.
   */
  const knownGaps = new Set(['getTranscript']);

  const dropped = [];
  for (const [name, want] of declared) {
    if (refuses.has(name) || knownGaps.has(name)) continue;
    const got = implemented.get(name);
    if (got && got.length < want.length) {
      dropped.push(`${name}: interface takes ${want.length} (${want
        .map((x) => x.split(':')[0].trim())
        .join(', ')}), daemon takes ${got.length}`);
    }
  }

  check('every daemon method accepts what the interface declares', dropped.length === 0, dropped.join('\n       '));
}

console.log('');
if (failures) {
  console.error(`BRIDGE-PARITY TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('BRIDGE-PARITY TEST PASSED\n');
