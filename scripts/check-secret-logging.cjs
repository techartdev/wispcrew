/**
 * Could a secret reach a log?
 *
 * `WISPCREW_LOG` writes a protocol log, and the protocol carries an API key
 * whenever someone configures a provider. A log file is the easiest place
 * for a credential to end up somewhere it should not: it is written by
 * default in some setups, copied into bug reports, and read by whoever asked
 * for one.
 *
 * A gate rather than a report — this failure is silent and permanent.
 */
const fs = require('fs');
const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

let bad = 0;
const fail = (msg) => {
  console.log('  FAIL ' + msg);
  bad++;
};

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

console.log('\n[the protocol log] frames are not written verbatim');
{
  const protocol = read('packages/runtime/src/protocol.ts');
  const server = read('packages/runtime/src/node-server.ts');
  const client = read('packages/runtime/src/node-client.ts');

  /*
   * The danger: `fileLog('[node] frame', JSON.stringify(frame))`. A
   * `saveSettings` call carries `apiKey`, so logging a whole frame logs the
   * key.
   */
  for (const [name, text] of [
    ['protocol.ts', protocol],
    ['node-server.ts', server],
    ['node-client.ts', client],
  ]) {
    const dumpsFrames = /fileLog\([^)]*JSON\.stringify\((frame|args|payload)\b/.test(text);
    if (dumpsFrames) fail(`${name} logs a whole frame, which may carry a key`);
    else console.log(`  ok   ${name}`);
  }
}

console.log('\n[secret handling] no log line takes a secret as an argument');
{
  const files = [
    'packages/runtime/src/secrets-store.ts',
    'packages/runtime/src/provider-keys.ts',
    'packages/runtime/src/oauth-store.ts',
    'apps/daemon/src/methods.ts',
    'apps/daemon/src/cli-commands.ts',
  ];

  for (const file of files) {
    const text = read(file);
    if (!text) continue;

    /*
     * Looking for `fileLog(..., key)` / `console.log(..., token)` — a
     * variable holding the value rather than a description of it.
     */
    const leaks = [
      ...text.matchAll(/(?:fileLog|console\.(?:log|error|warn))\([^)]*\b(apiKey|token|secret|credential|value)\b[^)]*\)/g),
    ].filter((m) => {
      const line = m[0];
      // Naming the KEY is fine; passing the value is not.
      return !/['"`]/.test(line.split(m[1])[1] ?? '') || /\$\{[^}]*\b(apiKey|token|secret)\b/.test(line);
    });

    if (leaks.length > 0) {
      fail(`${path.basename(file)}: ${leaks.length} log line(s) may carry a secret`);
      for (const l of leaks.slice(0, 2)) console.log(`       ${l[0].slice(0, 90)}`);
    } else {
      console.log(`  ok   ${path.basename(file)}`);
    }
  }
}

console.log('\n[what IS logged] descriptions, not values');
{
  const keys = read('packages/runtime/src/provider-keys.ts');

  // `fileLog('[keys] stored key for', presetId)` is right: it says something
  // happened without saying what the thing was.
  const good = /fileLog\('\[keys\][^']*',\s*presetId\)/.test(keys);
  if (good) console.log('  ok   provider-keys logs the preset, not the key');
  else fail('provider-keys does not log the way it used to; check it');
}

console.log('');
console.log(bad === 0 ? 'SECRET-LOGGING CHECK PASSED' : `SECRET-LOGGING CHECK FAILED — ${bad}`);
process.exit(bad === 0 ? 0 : 1);
