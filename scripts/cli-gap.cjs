/**
 * What can the desktop do that the CLI cannot?
 *
 * The standard this project holds the CLI to: it should lack a GUI, never
 * functionality. So the honest measure is the bridge surface — every
 * capability the desktop exposes — against what a CLI command reaches.
 *
 * Kept as a script rather than a one-off, because the answer changes with
 * every command added and "roughly 47 unreached" is not a number anyone can
 * act on twice.
 */
const fs = require('fs');
const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

const bridge = fs.readFileSync('packages/shared/src/bridge.ts', 'utf8');
const commands = fs.readFileSync('apps/daemon/src/cli-commands.ts', 'utf8');

/* Every method the desktop can call. */
const methods = new Set();
for (const m of bridge.matchAll(/^ {2}(\w+)\(/gm)) methods.add(m[1]);

/*
 * Every method a CLI command calls.
 *
 * Matched on the quoted name after `call`, allowing anything between —
 * `call<Record<string, unknown>[]>('listAgents')` has nested angle brackets,
 * and a `call<[^>]*>` pattern silently missed every one of them, reporting
 * sixteen working commands as gaps.
 */
const used = new Set();
for (const m of commands.matchAll(/\bcall(?:<[\s\S]*?>)?\(\s*'(\w+)'/g)) used.add(m[1]);
// Some are reached through the runtime directly rather than the protocol —
// the paired-machine registry is client-side state, so `pair` and `machines`
// call `addNode`/`listNodes` instead of asking a node.
for (const m of commands.matchAll(/\b(addNode|listNodes|removeNode|pairWithNode)\(/g)) {
  used.add({ addNode: 'pairNode', listNodes: 'listNodes', removeNode: 'forgetNode', pairWithNode: 'pairNode' }[m[1]]);
}

/**
 * Capabilities a CLI genuinely cannot or should not have, each with the
 * reason. Anything NOT here and not reached is a real gap.
 */
const GUI_ONLY = {
  getAppInfo: 'window chrome and app version',
  openExternal: 'needs a browser',
  openPath: 'needs a file manager',
  showItemInFolder: 'needs a file manager',
  pickFiles: 'needs a file dialog',
  pickDirectory: 'needs a file dialog',
  oauthSignIn: 'needs a browser on the user\u2019s screen',
  onEvent: 'a push channel, not a command',
  offEvent: 'a push channel, not a command',
};

/** Reached by a command under a different name, or covered by one. */
const COVERED = {
  listApprovals: 'approvals',
  resolveApproval: 'approvals allow / deny',
  sendPrompt: 'ask',
  runRoutineNow: 'routines run',
  revokeAllToolGrants: 'grants revoke --all',
  writeSettings: 'configure (uses saveSettings)',
  clearTranscript: 'rooms clear',
  addRoomAgent: 'rooms add',
  removeRoomParticipant: 'rooms remove',
};

const missing = [...methods]
  .filter((m) => !used.has(m) && !GUI_ONLY[m] && !COVERED[m])
  .sort();

console.log('bridge methods   :', methods.size);
console.log('reached by a CLI :', used.size);
console.log('GUI-only         :', Object.keys(GUI_ONLY).length);
console.log('covered by a name:', Object.keys(COVERED).length);
console.log('');
console.log(`GAPS (${missing.length}):`);
for (const name of missing) console.log('  ' + name);

// A non-zero exit would make this a gate; it is a report, so it always
// succeeds. Turning it into a gate is a decision for when the list is short.
