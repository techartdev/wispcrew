/**
 * migration-test.mjs — a rename must not cost anyone their data.
 *
 * Renaming the app moves its userData directory. Without a working
 * migration every existing user loses agents, conversations, routines,
 * provider keys and paired machines — silently, because an empty profile
 * looks like a first run rather than a failure.
 *
 * The migration lives in the desktop app because it needs Electron's
 * `app.getPath`. This exercises its *rules* — which files move, which are
 * renamed, which are dropped — and checks them against a real profile where
 * one exists, since a synthetic fixture would not contain the leftovers,
 * the Chromium caches, or a live daemon endpoint that make this delicate.
 *
 * Offline: files only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(
  path.join(repo, 'apps', 'desktop', 'src', 'main', 'userdata-migration.ts'),
  'utf8',
);

/*
 * The rules are read from the module rather than duplicated here.
 *
 * A copy would drift, and the failure would be silent: this test would keep
 * passing while the real migration quietly dropped something.
 */
const setOf = (name) => {
  const match = new RegExp(`const ${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  if (!match) throw new Error(`could not read ${name} from the migration`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
};

const renames = (() => {
  const match = /const FILE_RENAMES[^=]*= \{([\s\S]*?)\n\};/.exec(source);
  const out = {};
  for (const m of match[1].matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
  return out;
})();

const passthrough = setOf('PASSTHROUGH');
const passthroughDirs = setOf('PASSTHROUGH_DIRS');
const obsolete = setOf('OBSOLETE');

console.log('\n[rules] the migration knows about the previous name');
{
  check('settings are renamed', renames['ghostbot-settings.json'] === 'wispcrew-settings.json');
  check('secrets are renamed', renames['ghostbot-secrets.enc'] === 'wispcrew-secrets.enc');
  // The daemon handoff copy is easy to forget, and losing it is invisible
  // until an agent next tries to run unattended.
  check('the daemon secrets copy is renamed',
    renames['ghostbot-secrets-node.enc'] === 'wispcrew-secrets-node.enc');
  check('the older OpenAgent names still work',
    renames['openagent-settings.json'] === 'wispcrew-settings.json');
  check('the previous profile directory is searched',
    /path\.join\(appData, 'GhostBot'\)/.test(source));
}

console.log("\n[rules] the user's work carries over");
{
  for (const name of ['agents.json', 'routines.json', 'nodes.json', 'node-key']) {
    check(`${name} passes through`, passthrough.has(name));
  }

  /*
   * The original migration copied FILES ONLY. That was right when
   * transcripts were flat `<product>-transcript-<id>.json` files; they now
   * live in `transcripts/`, so a file-only migration would silently drop
   * every conversation.
   */
  for (const dir of ['transcripts', 'checkpoints', 'skills']) {
    check(`the ${dir} directory carries over`, passthroughDirs.has(dir));
  }
  check('directories are actually copied', /entry\.isDirectory\(\)/.test(source));
  check('recursively', /function copyTree/.test(source));
}

console.log('\n[rules] dead files are not carried forward again');
{
  // These are in real profiles right now, left behind by the last rename.
  check('the stale agents file is dropped', obsolete.has('ghostbot-agents.json'));
  check('the stale local-agent transcript is dropped',
    obsolete.has('ghostbot-transcript-local-agent.json'));
  check('and rejection happens before any rename', /OBSOLETE\.has\(name\)/.test(source));
}

console.log('\n[safety] a profile that has been used is never overwritten');
{
  /*
   * The original marker was "a file starting with wispcrew-". A GhostBot
   * profile has none, so a second launch would have migrated again on top
   * of live data.
   */
  check('the marker is product-neutral', /existing\.includes\('agents\.json'\)/.test(source));
}

console.log('\n[real profile] the rules cover what is actually on this machine');
{
  const real = process.env.APPDATA ? path.join(process.env.APPDATA, 'GhostBot') : null;

  if (!real || !fs.existsSync(real)) {
    console.log('  --   no previous profile here; the rules above are what matter');
  } else {
    const entries = fs.readdirSync(real, { withFileTypes: true });
    const unhandled = [];

    for (const entry of entries) {
      const name = entry.name;
      if (obsolete.has(name)) continue;

      if (entry.isDirectory()) {
        if (!passthroughDirs.has(name)) unhandled.push(name);
        continue;
      }
      if (renames[name] || passthrough.has(name) || name.startsWith('wispcrew-')) continue;
      if (/^(?:openagent|ghostbot)-transcript-.+\.json$/.test(name)) continue;

      unhandled.push(name);
    }

    /*
     * Being left behind is correct for Chromium's caches and for a daemon
     * endpoint belonging to the old installation — but that must be a
     * deliberate list, not an accident, so anything outside it fails here.
     */
    const expected = new Set([
      'blob_storage', 'Cache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'GPUCache', 'Local Storage', 'Network', 'Session Storage', 'Shared Dictionary',
      'DIPS', 'Local State', 'Preferences', 'SharedStorage', 'SharedStorage-wal',
      'node-endpoint.json',
    ]);
    const surprising = unhandled.filter((n) => !expected.has(n));

    console.log(`  --   ${entries.length} entries, ${unhandled.length} deliberately left behind`);
    check('nothing unexpected is dropped', surprising.length === 0, surprising.join(', '));

    const agents = path.join(real, 'agents.json');
    if (fs.existsSync(agents)) {
      const count = JSON.parse(fs.readFileSync(agents, 'utf8')).length;
      check(`${count} real agent(s) would carry over`, passthrough.has('agents.json'));
    }
    if (fs.existsSync(path.join(real, 'transcripts'))) {
      const n = fs.readdirSync(path.join(real, 'transcripts')).length;
      check(`all ${n} real conversations would carry over`, passthroughDirs.has('transcripts'));
    }
  }
}

console.log('');
if (failures) {
  console.error(`MIGRATION TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('MIGRATION TEST PASSED\n');
