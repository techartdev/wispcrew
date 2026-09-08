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
import os from 'node:os';
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

console.log('\n[claude subscription] the request must identify as Claude Code');
{
  /*
   * Why Claude inference never worked, and why nobody could tell.
   *
   * Anthropic refuses a subscription request that does not identify itself,
   * and the refusal is HTTP 429 with
   * `{"type":"rate_limit_error","message":"Error"}` and
   * `x-should-retry: true`. That is indistinguishable from a real rate
   * limit, so it was recorded as one — in the code, in AGENTS.md, and in
   * every status note — for weeks.
   *
   * Measured live against a real subscription account, all in one run:
   *
   *   identity only, as a string ............ 200
   *   identity + our prompt, ONE STRING ..... 429
   *   identity + our prompt, as BLOCKS ...... 200
   *   our prompt first, identity second ..... 429
   *   our prompt alone ...................... 429
   *
   * So the text being present is not enough. The system must be an ARRAY
   * whose FIRST block is exactly that sentence — concatenating it into one
   * string produces the same 429, which is the trap: the obvious fix looks
   * like the bug it was already mistaken for.
   */
  const src = fs.readFileSync(path.join(repo, 'packages/llm/src/anthropic.ts'), 'utf8');

  check('the identity is exact',
    /You are Claude Code, Anthropic's official CLI for Claude\./.test(src));
  check('it is sent as the first block',
    /system: \[\s*\{ type: 'text', text: CLAUDE_CODE_IDENTITY \}/.test(src),
    'concatenating into one string is refused with a 429');
  check('and our own prompt follows as a second block',
    /systemParts\.join\('\\n\\n'\) \}\] : \[\]\)/.test(src));

  // An API key needs none of this, and adding it would be noise in every
  // request from somebody who is not on a subscription.
  check('only for a subscription token', /this\.usesSubscription\(\)/.test(src));
  check('which is what the token prefix says',
    /startsWith\('sk-ant-oat'\)/.test(src));
}

console.log('\n[web_fetch] auto-approved, so it must not reach the inside');
{
  /*
   * `web_fetch` is in SAFE_TOOLS — it runs with no approval card, on the
   * reasoning that reading a public page is harmless. It validated the
   * PROTOCOL and nothing else, so an agent could read
   * `http://169.254.169.254/latest/meta-data/` and hand back cloud
   * credentials, with no card and nothing to deny: `readonly` policy only
   * blocks calls that need approval, and this never did.
   *
   * Worst on exactly the deployment this project encourages — an agent on a
   * VPS. Found by an agent reviewing this repository.
   */
  const { isPrivateAddress, ToolRegistry: Registry } = await import('@wispcrew/tools');

  for (const [address, what] of [
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['192.168.1.1', 'a home router'],
    ['172.16.0.1', 'private'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ]) {
    check(`${what} is refused`, isPrivateAddress(address), address);
  }

  // And the boundaries, because a range that is too wide silently breaks
  // ordinary fetching, which is the failure nobody reports.
  check('172.32.x is public', !isPrivateAddress('172.32.0.1'));
  check('a public address is allowed', !isPrivateAddress('93.184.216.34'));

  /*
   * Checked at EVERY redirect hop. A public URL that redirects to
   * 169.254.169.254 is a one-line redirector, and a check performed only on
   * the URL the model supplied would not see it.
   */
  const web = fs.readFileSync(path.join(repo, 'packages/tools/src/web.ts'), 'utf8');
  check('redirects are followed by hand', /redirect: 'manual'/.test(web));
  check('and re-checked each hop', /await refuseIfPrivate\(target\)/.test(web));
  check('with a hop limit', /MAX_REDIRECTS/.test(web));

  // Through the real tool, not just the predicate.
  const refused = await new Registry().execute(
    'web_fetch',
    { url: 'http://169.254.169.254/latest/meta-data/' },
    { workspaceRoot: repo },
  );
  check('the tool itself refuses metadata', !refused.ok && refused.errorCode === 'blocked_address',
    refused.errorCode);
}

console.log('\n[the node socket] an anonymous connection is bounded');
{
  /*
   * `buffered += chunk` had no cap and nothing timed out before `hello`, on
   * a port documented as internet-reachable. An anonymous connection
   * sending an endless stream with no newline grew the string until the
   * daemon died — no token, no pairing code, no protocol knowledge needed.
   */
  const src = fs.readFileSync(path.join(repo, 'packages/runtime/src/node-server.ts'), 'utf8');

  check('a silent connection is closed', /AUTH_DEADLINE_MS/.test(src));
  check('the pre-auth buffer is capped', /MAX_PREAUTH_BYTES/.test(src));
  check('and an authenticated frame too', /MAX_FRAME_BYTES/.test(src));
  check('the cap is enforced, not just declared',
    /buffered\.length > cap/.test(src));
  // A timer that keeps the process alive would trade one bug for another.
  check('the deadline does not hold the process open', /authDeadline\.unref/.test(src));
}

console.log('\n[deleting an agent] takes everything it owned with it');
{
  /*
   * The cleanup lived in the DESKTOP bridge only — clearSession,
   * revokeForAgent, and deleting the agent's routines. The daemon's method
   * table called the bare store function, and the daemon is normally what
   * runs, because agent-scoped calls route to the node that owns the agent.
   * So the complete path was the one that almost never executed.
   *
   * `grants.ts` promises a grant is "dropped when their agent is deleted,
   * so a recreated id cannot inherit a permission granted to something
   * else". Through the daemon, it was not. And an orphaned routine fires on
   * its cron forever, because the scheduler never checks the agent exists.
   *
   * Tested through the STORE, which is what both hosts now call — the
   * previous test could not have caught this, because it asserted against
   * the same single function while the divergence lived in the callers.
   */
  const rt = await import('@wispcrew/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-delete-'));

  rt.setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: rt.createNodeCrypto(dir) });
  rt.initStore(dir);
  rt.initGrants(dir);

  const agent = rt.createAgent({ name: 'Doomed', presetId: 'openai', model: 'gpt-5.6-luna', workspaceRoot: dir });
  rt.createRoutine({ agentId: agent.id, name: 'nightly', cron: '0 9 * * *', prompt: 'check' });
  rt.grant(agent.id, 'shell');

  check('the fixture is real', rt.listRoutines(agent.id).length === 1 && rt.isGranted(agent.id, 'shell'));

  rt.deleteAgent(agent.id);

  check('its routines go with it', rt.listRoutines(agent.id).length === 0,
    'an orphan fires on its cron forever');
  check('and its standing grants', !rt.isGranted(agent.id, 'shell'),
    'a permission the user believes they destroyed');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[missing arguments] a tool says what it needed');
{
  /*
   * A confusing error does not just fail one call — it teaches the model to
   * keep failing.
   *
   * When arguments did not arrive, the tool ran anyway and failed inside
   * itself, so the model was told `The "paths[1]" argument must be of type
   * string. Received undefined`. That is Node's internals; it names nothing
   * the model can act on, and it cannot even tell that its ARGUMENTS were
   * the problem. So it retried the identical call, repeatedly.
   *
   * And every failure stays in the transcript. Measured on a real
   * conversation: after the underlying serialisation bug was fixed, a FRESH
   * agent on the same model, build and daemon called the tool correctly
   * while the existing one kept sending `{}` — it was copying its own
   * failures out of its history.
   */
  const { ToolRegistry } = await import('@wispcrew/tools');
  const registry = new ToolRegistry();
  const ctx = { workspaceRoot: repo };

  const readFile = await registry.execute('read_file', {}, ctx);
  check('the failure is about the arguments', readFile.errorCode === 'bad_arguments',
    readFile.errorCode);
  check('it names what was missing', /without `path`/.test(readFile.content), readFile.content);
  check('and what the tool needs', /requires `path` \(string\)/.test(readFile.content));
  // A shape is easier to copy than a description — and a description is
  // exactly what this model had already failed to act on.
  check('with a concrete example', /\{"path":"…"\}/.test(readFile.content), readFile.content);

  const shell = await registry.execute('shell', {}, ctx);
  check('the same for shell', /without `command`/.test(shell.content), shell.content);

  /*
   * And a tool with nothing required still runs. `list_dir` defaults to the
   * workspace root, which is why it was the ONE call that worked throughout
   * the incident — it could not tell the difference.
   */
  const listDir = await registry.execute('list_dir', {}, ctx);
  check('a tool with no required arguments still runs', listDir.ok, listDir.content);
}

console.log('\n[claude tool calls] arguments have to survive the stream');
{
  /*
   * Reported by an agent that diagnosed its own tooling precisely: "every
   * tool call that requires arguments is coming back with an
   * argument-parsing error — read_file says paths[1] must be of type
   * string. Received undefined… the only call that works is list_dir with
   * no arguments." A weaker model on the same harness worked, which
   * correctly pointed at the Anthropic adapter rather than the tool layer.
   *
   * Two faults, both unreachable until Claude inference started working an
   * hour earlier — no Anthropic tool call had ever been streamed.
   */
  const src = fs.readFileSync(path.join(repo, 'packages/llm/src/anthropic.ts'), 'utf8');

  /*
   * 1. `input_json_delta` carries `partial_json`, not `text`. Reading
   *    `text` meant the accumulator stayed empty and every call arrived as
   *    `{}` — "there is no agent called undefined".
   */
  check('the tool fragment is read from partial_json',
    /d\.partial_json \?\? d\.text/.test(src),
    'reading only `text` leaves every tool call with empty arguments');
  check('and the field is declared', /partial_json\?: string/.test(src));

  /*
   * 2. The content-block INDEX was used as an array index while a block was
   *    also pushed. Identical for a single tool at index 0, and divergent
   *    the moment anything precedes it — which a `thinking` block now
   *    always does, emitting the same call twice, once with no arguments.
   */
  check('one block per tool, in stream order',
    /for \(const acc of toolBlocks\.values\(\)\)/.test(src),
    'indexing by the content-block index emits a duplicate empty call');

  /*
   * Comments stripped before this one. The first version failed on the
   * comment that EXPLAINS the fix, which names the pattern it removed —
   * the third time a check here has caught its own prose. A test that reads
   * source has to look at code, not at writing about code.
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('and no index-assignment remains', !/content\[idx\]/.test(code));
}

console.log('\n[a 429 is not proof of a spent plan]');
{
  /*
   * Reported straight after a successful sign-in: "it said I'm out of
   * usage, which is wrong". It was wrong.
   *
   * Every 429 was reported as "Your Claude plan's usage limit is currently
   * reached", and the response body was read and discarded. Captured from
   * the reporter's own account, moments after signing in:
   *
   *   HTTP 429
   *   x-should-retry: true
   *   {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}
   *
   * A spent plan does not tell you to retry. The two cases are hours apart
   * in meaning — wait a moment, versus stop for the day — and the evidence
   * to tell them apart was in the headers all along.
   */
  const src = fs.readFileSync(path.join(repo, 'packages/llm/src/anthropic.ts'), 'utf8');

  check('the retry header is read', /x-should-retry/.test(src),
    'the only reliable signal is being ignored');
  check('and it prevents the quota claim',
    /!shouldRetry && \/usage limit\|quota/.test(src));
  check('a rate limit says what it is', /rate-limiting this request/.test(src));
  check('and suggests when to retry', /Try again in \$\{retryAfter\}s\./.test(src));

  /*
   * Anthropic's 429 message is the single word "Error". Quoting it makes a
   * clear sentence look like a stack trace, so a useless message is dropped
   * rather than passed through.
   */
  check('a useless provider message is not quoted',
    /\^\(error\|unknown\|bad request\)/.test(src));

  // And the body is no longer read and thrown away.
  check('the body is actually used', /extractAnthropicMessage\(text\)/.test(src));
}

console.log('\n[signing in] happens on the machine with the browser');
{
  /*
   * Reported with a screenshot: "Error invoking remote method
   * 'wc:oauthSignIn': Signing in needs a browser. Sign in on the machine you
   * are sitting at" — shown to somebody who WAS sitting at it.
   *
   * The daemon implements `oauthSignIn` and `oauthImportFromCli` only to
   * refuse: a background process has no browser and no CLI files of its own.
   * The desktop forwarded to it anyway, so Claude sign-in was unreachable
   * from the app entirely. The daemon runs on this machine too — its
   * browserlessness is a fact about the daemon, not about the user.
   */
  const bridge = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/bridge-host.ts'), 'utf8');
  const localOnly = bridge.match(/const LOCAL_ONLY = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';

  check('signing in is not forwarded', /'oauthSignIn'/.test(localOnly));
  check('nor is importing a CLI sign-in', /'oauthImportFromCli'/.test(localOnly));

  /*
   * And the credential must reach the DAEMON, which is what runs turns. The
   * desktop encrypts with the OS keychain, which a background process cannot
   * open, so a second copy goes under the machine-local key. That handoff ran
   * only at startup — a sign-in completed while the app was running would
   * have worked until the next restart and then stopped.
   */
  check('every sign-in path hands off to the daemon',
    (bridge.match(/handOffToDaemon\(\)/g) ?? []).length >= 3,
    'one of the three paths does not hand off');
  check('and a failed handoff does not lose the sign-in',
    /handoff after sign-in failed/.test(bridge));

  /*
   * The guard originally asked only whether a forwarded method EXISTS on the
   * node. These two do — they exist in order to say no — so it passed them.
   * Existing and being appropriate to forward are different questions.
   */
  const guard = fs.readFileSync(path.join(repo, 'scripts/check-bridge-methods.cjs'), 'utf8');
  check('the guard now catches a method that only refuses', /refusers/.test(guard));
  check('and names the fix', /LOCAL_ONLY in bridge-host\.ts/.test(guard));
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
