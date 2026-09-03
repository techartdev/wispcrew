/**
 * hardening-test.mjs — the properties a public release depends on.
 *
 * Three things a stranger's first bad day will test, and which no amount of
 * careful reading catches:
 *
 *   1. A failure names the next action, rather than an internal detail.
 *   2. A destructive command refuses to guess.
 *   3. A secret never reaches a log, a settings file, or a --json payload.
 *
 * Checked against the source rather than by running commands, because the
 * interesting cases are the ones nobody runs on purpose.
 *
 * Offline: reads files, executes nothing.
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

const commands = fs.readFileSync(path.join(repo, 'apps/daemon/src/cli-commands.ts'), 'utf8');
const connect = fs.readFileSync(path.join(repo, 'apps/daemon/src/cli-connect.ts'), 'utf8');
const output = fs.readFileSync(path.join(repo, 'apps/daemon/src/cli-output.ts'), 'utf8');

console.log('\n[errors] a failure says what to do next');
{
  /*
   * "ECONNREFUSED" tells someone nothing. "No daemon is running, start one
   * with wispcrew serve" tells them the next command to type.
   */
  check('a missing daemon names the fix', connect.includes('wispcrew serve'));
  check('and shows which profile', connect.includes('profile'));

  // An unknown name lists what exists, rather than only refusing.
  check('an unknown agent lists the real ones', commands.includes('Available:'));

  /*
   * An ambiguous name is refused, never resolved by picking the first —
   * that would send work to the wrong machine or delete the wrong thing.
   */
  const ambiguous = (commands.match(/More than one/g) ?? []).length;
  check('ambiguity is refused, not guessed', ambiguous >= 3, `${ambiguous} places`);
}

console.log('\n[destructive] nothing irreversible happens by accident');
{
  /*
   * A destructive command that proceeds because nobody was there to object
   * is how an automation loses data it cannot get back.
   */
  const guarded = (commands.match(/args\.yes !== true/g) ?? []).length;
  check('several commands require --yes', guarded >= 4, `${guarded} guarded`);

  // Every one of those must say what it is about to destroy.
  const named = (commands.match(/Re-run with --yes/g) ?? []).length;
  check('and each says what it would remove', named >= 3, `${named} messages`);

  /*
   * The exception worth checking: restoring history replaces a transcript
   * and is reversible, because the version being replaced is saved first.
   * Demanding --yes for a reversible action trains people to type it.
   */
  check('a reversible action does not demand --yes',
    commands.includes('The version you replaced was saved too.'));
}

console.log('\n[secrets] a key never travels further than it must');
{
  /*
   * Hard rule 5, checked at the CLI edge. `configure --key` must hand the
   * value to the node and keep nothing: no echo, no log line, no local copy.
   */
  const configure = commands.slice(
    commands.indexOf('export async function configure'),
    commands.indexOf('export async function settingsShow'),
  );

  check('configure sends the key onward', configure.includes('saveSettings'));

  // The key must never be printed back, in either mode.
  check('and never prints it', !/lines:[\s\S]*\bkey\b[\s\S]*patch\.apiKey/.test(configure));
  check('reporting only whether one is set', configure.includes('hasApiKey'));

  /*
   * `settings` shows configuration, and the node's own view already strips
   * the key — but a caller reading this file should see that stated.
   */
  const settings = commands.slice(
    commands.indexOf('export async function settingsShow'),
    commands.indexOf('/* ---', commands.indexOf('export async function settingsShow')),
  );
  check('settings reports presence, not value', settings.includes('hasApiKey'));
  check('and never reads apiKey', !settings.includes('.apiKey'));
}

console.log('\n[machine output] --json is exactly one object');
{
  /*
   * The contract a script depends on. Prose wrapped around JSON turns a
   * parseable result into a scraping problem, and the caller finds out in
   * production.
   */
  check('json mode writes the value alone',
    output.includes("if (opts.mode === 'json')") && output.includes('JSON.stringify(result.value)'));

  // Errors go to stderr even in text mode, so `cmd --json > out` leaves a
  // parseable file and a readable complaint.
  check('errors go to stderr', output.includes('process.stderr.write'));
  check('and are JSON in machine modes', /mode === 'text'[\s\S]*?stderr[\s\S]*?JSON.stringify/.test(output));
}

console.log('\n[plaintext settings] a credential cannot be written there');
{
  /*
   * This shipped, and was found on a real profile: 46 characters of live
   * Telegram bot token sitting in `wispcrew-settings.json`, a plaintext
   * file somebody might reasonably paste into a bug report.
   *
   * The desktop bridge always routed the token through `upsertSecrets`.
   * The NODE's `saveSettings` destructured only `apiKey` and wrote
   * everything else verbatim — and the node is what answers when a daemon
   * owns the profile, which is every normal install. One omission produced
   * both symptoms at once: the credential exposed, and "no bot token is
   * saved" shown immediately after saving one.
   *
   * Hard rule 5 said this must not happen. A rule every call site has to
   * remember is a hope, so it now lives at the choke point.
   */
  const os = await import('node:os');
  const { writeSettings, readSettings } = await import('@wispcrew/runtime');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-settings-'));

  for (const field of ['apiKey', 'telegramToken']) {
    let threw = '';
    try {
      writeSettings(dir, { [field]: 'live-credential-value' });
    } catch (err) {
      threw = err.message;
    }
    // Refused LOUDLY. Silently dropping a credential shipped once on the
    // configureNode path: the call reported success and stored nothing.
    check(`${field} is refused`, threw !== '', 'it was accepted');
    check(`and the refusal names ${field}`, threw.includes(field), threw);
    check(`${field} never reaches the file`,
      !JSON.stringify(readSettings(dir)).includes('live-credential-value'));
  }

  /*
   * And the view's own answers are not settings. `getSettings` decorates
   * its reply with these; a UI handing the object back persisted them, and
   * they then shadowed the real answer on the next read. All three were in
   * that same profile.
   */
  writeSettings(dir, { presetId: 'openai', hasApiKey: true, isEncrypted: false });
  const after = readSettings(dir);
  check('derived answers are not persisted',
    !('hasApiKey' in after) && !('isEncrypted' in after), JSON.stringify(after));
  check('but real settings are', after.presetId === 'openai');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`HARDENING TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('HARDENING TEST PASSED\n');
