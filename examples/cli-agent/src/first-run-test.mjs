/**
 * first-run-test.mjs — what a newcomer meets, without needing a clean machine.
 *
 * The first five minutes decide whether anyone continues, and this is the one
 * path a developer cannot test by hand: their profile already has keys,
 * agents and settings that a newcomer does not.
 *
 * Attempting it live proved that. A "clean" `--user-data-dir` still reported
 * `imported 19 file(s) from ...\GhostBot`, because migration resolves the
 * legacy path through Electron's own `appData` and a rename is exactly what
 * it exists to survive. Correct behaviour, and it means the live route
 * measures an upgrade rather than a first run.
 *
 * So the pieces are checked here instead, where the profile is genuinely
 * empty because the test created it.
 *
 * Offline: store and settings only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentWithRoom,
  createNodeCrypto,
  defaultSettings,
  hasProviderKey,
  initStore,
  listAgents,
  listConversations,
  readSettings,
  setHost,
} from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-firstrun-'));
setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 'new', crypto: createNodeCrypto(dir) });
initStore(dir);

console.log('\n[an empty profile] nothing is invented');
{
  check('no agents yet', listAgents().length === 0, String(listAgents().length));
  check('no conversations', listConversations().length === 0);

  const settings = readSettings(dir, defaultSettings());

  /*
   * A default preset is fine — something has to be selected — but a key must
   * never be assumed. "Configured" and "working" are different states, and
   * conflating them is how someone ends up debugging a provider they never
   * set up.
   */
  check('a provider is preselected', typeof settings.presetId === 'string');
  check('but no key is claimed', hasProviderKey(dir, settings.presetId) === false);
}

console.log('\n[the first agent] arrives with a room, or it cannot be talked to');
{
  const agent = createAgentWithRoom({ name: 'Assistant' });

  check('the agent exists', listAgents().length === 1);

  /*
   * The failure this prevents: an agent created without a room is in the
   * roster, renders in the sidebar, and silently does nothing with a
   * message. That shipped once, for every agent created after startup.
   */
  const room = listConversations().find((c) => c.id === agent.id);
  check('and has a room', Boolean(room));
  check('with the agent in it',
    (room?.participants ?? []).some((p) => p.kind === 'agent' && p.id === agent.id));
  check('and a human in it',
    (room?.participants ?? []).some((p) => p.kind === 'human'));
}

console.log('\n[storage] nothing sensitive is written before it exists');
{
  const files = fs.readdirSync(dir);

  // A settings file is expected; a secrets file before any key is not.
  check('no secrets file yet', !files.includes('wispcrew-secrets.enc'),
    files.join(', '));

  const settingsFile = path.join(dir, 'wispcrew-settings.json');
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    // Hard rule 5: a key never belongs in the plaintext settings.
    check('no apiKey field in settings', !/"apiKey"\s*:\s*"[^"]/.test(raw));
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`FIRST-RUN TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('FIRST-RUN TEST PASSED\n');
