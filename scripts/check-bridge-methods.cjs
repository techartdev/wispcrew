/**
 * check-bridge-methods.cjs — every forwarded bridge method must exist on the node.
 *
 * The desktop forwards bridge calls to the daemon whenever one owns the
 * profile, which is the normal case for any real install. A method
 * implemented only in `bridge-host.ts` therefore fails at the moment of use
 * with `Unknown method "x"` — it typechecks, it builds, every offline suite
 * passes, and it is broken for every user.
 *
 * That shipped. "Find my chat" in the Telegram settings was desktop-only, so
 * pressing it reported `Error invoking remote method 'wc:discoverChatId':
 * Unknown method "discoverChatId"`. Auditing the rest found ELEVEN more in
 * the same state, of which two were real gaps (`updateMcpServer`,
 * `setMcpToolEnabled`) and nine were calls that must never be forwarded at
 * all — native dialogs, and this desktop's own view of other machines.
 *
 * `scripts/check-cli-methods.cjs` has guarded the CLI against exactly this
 * since the CLI existed. The desktop, which is the deliverable, had no
 * equivalent. This is it.
 */
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const bridgeSrc = fs.readFileSync(
  path.join(repo, 'apps/desktop/src/main/bridge-host.ts'),
  'utf8',
);

/* Every `handle('name', …)` in the desktop bridge. */
const handled = [...bridgeSrc.matchAll(/handle\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

/*
 * The explicit local-only list, read from the source rather than restated.
 *
 * Restating it here would be a second record of one fact — the bug class
 * this project keeps meeting — so the set is parsed out of the declaration
 * it is actually enforced by.
 */
const localBlock = bridgeSrc.match(/const LOCAL_ONLY = new Set\(\[([\s\S]*?)\]\)/);
const localOnly = new Set(
  localBlock ? [...localBlock[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]) : [],
);

if (!localBlock) {
  console.error('LOCAL_ONLY is missing from bridge-host.ts — nothing declares what stays here.');
  process.exit(1);
}

let onNode;
try {
  ({ nodeMethods: onNode } = require(path.join(repo, 'apps/daemon/dist/methods.js')));
} catch (err) {
  console.error(`Build the daemon first: ${err.message}`);
  process.exit(1);
}

const nodeTable = new Set(Object.keys(onNode({})));

const missing = handled.filter((name) => !nodeTable.has(name) && !localOnly.has(name));

/*
 * And the reverse: a method listed as local that the node ALSO implements is
 * not an error, but one listed as local that no longer exists is dead weight
 * pointing at a method somebody renamed.
 */
const staleLocal = [...localOnly].filter((name) => !handled.includes(name));

if (missing.length) {
  console.error('These bridge methods are forwarded to the node but do not exist there:\n');
  for (const name of missing) console.error(`  ${name}`);
  console.error(
    '\nEither implement each on the node, or add it to LOCAL_ONLY in bridge-host.ts if\n' +
      'it must run on this machine. Left as is, it fails with `Unknown method` the first\n' +
      'time a user presses the button.',
  );
  process.exit(1);
}

if (staleLocal.length) {
  console.error(`LOCAL_ONLY names methods that no longer exist: ${staleLocal.join(', ')}`);
  process.exit(1);
}

console.log(
  `every forwarded bridge method exists on the node ` +
    `(${handled.length} handlers, ${localOnly.size} kept local)`,
);
