/**
 * platform-audit-test.mjs — the cross-platform assumptions, checked here.
 *
 * This project has been caught twice by platform differences that only CI
 * found: `ps -o etimes=` is a Linux extension that macOS rejects, and a
 * Windows runner refused every way of reading a process start time. Both
 * were silent failures — the code returned a wrong answer rather than
 * erroring.
 *
 * With CI unavailable, the next best thing is to check the assumptions that
 * can be checked from anywhere: path lengths, format parsing, and the shape
 * of the platform branches themselves. It cannot replace running on macOS,
 * but it turns "probably fine" into a list of things actually verified.
 *
 * Offline: no processes spawned, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseElapsed } from '@wispcrew/runtime';

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const repo = fileURLToPath(new URL('../../../', import.meta.url));

console.log('\n[socket paths] a Unix socket path has a hard kernel limit');
{
  /*
   * `sun_path` is 104 bytes on macOS/BSD and 108 on Linux. Exceeding it
   * fails at bind() with ENAMETOOLONG and the daemon simply never starts.
   * The socket is `<dataDir>/node.sock`, so the profile directory decides.
   */
  const cases = [
    ['macOS home', '/Users/somebody/Library/Application Support/WispCrew', 104],
    ['macOS long name', '/Users/a-rather-long-account-name/Library/Application Support/WispCrew', 104],
    ['macOS temp', '/var/folders/xy/1a2b3c4d5e6f7g8h9i0j/T/wispcrew-verify-12345', 104],
    ['Linux home', '/home/somebody/.config/WispCrew', 108],
    ['Linux temp', '/tmp/wispcrew-verify-12345', 108],
  ];

  for (const [label, dir, limit] of cases) {
    const bytes = Buffer.byteLength(path.posix.join(dir, 'node.sock'), 'utf8');
    // 20 bytes of headroom, so a slightly longer real path is still safe.
    check(`${label} fits (${bytes}/${limit})`, bytes + 20 <= limit, `${limit - bytes} spare`);
  }
}

console.log('\n[ps output] every format the POSIX branch must parse');
{
  // macOS and Linux both emit `etime` as [[dd-]hh:]mm:ss, with padding that
  // differs between them.
  check('mm:ss', parseElapsed('05:30') === 330);
  check('hh:mm:ss', parseElapsed('01:05:30') === 3930);
  check('dd-hh:mm:ss', parseElapsed('2-01:05:30') === 176_730);
  check('leading space (macOS pads)', parseElapsed('   00:07') === 7);
  check('trailing newline', parseElapsed('05:30\n') === 330);
  // Refusing to guess matters: a wrong number lets a recycled pid pass as
  // the original process.
  check('an unparseable value is rejected', parseElapsed('unknown') === null);
  check('an empty value is rejected', parseElapsed('') === null);
}

console.log('\n[branches] every platform branch has a non-Windows path');
{
  /*
   * A `win32` branch with no else is a bug waiting on another platform.
   * This does not prove the else is CORRECT — only that it exists, which is
   * the failure mode that has actually occurred here.
   */
  const files = [
    'packages/runtime/src/node-identity.ts',
    'packages/tools/src/shell.ts',
    'packages/mcp/src/client.ts',
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    const branches = (source.match(/process\.platform === 'win32'/g) ?? []).length;
    if (branches === 0) continue;

    // Every branch should be paired with an else, a ternary, or a negation.
    const alternatives =
      (source.match(/\}\s*else/g) ?? []).length +
      (source.match(/\?\s*[\s\S]{0,80}?\s*:/g) ?? []).length +
      (source.match(/!isWin|isWin \?/g) ?? []).length;

    check(
      `${path.basename(file)} handles non-Windows (${branches} branch${branches === 1 ? '' : 'es'})`,
      alternatives >= branches,
      `${branches} branches, ${alternatives} alternatives`,
    );
  }
}

console.log('\n[paths] nothing hard-codes a Windows separator');
{
  /*
   * A literal backslash in a path built for the filesystem breaks on POSIX.
   * Named pipes are the exception — `\\.\pipe\...` is a Windows-only kernel
   * name and correctly literal.
   */
  const suspicious = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;

      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/['"`]([^'"`\n]*\\\\[^'"`\n]*)['"`]/g)) {
        const literal = match[1];
        if (literal.includes('pipe')) continue; // Windows named pipe
        if (/\\\\d|\\\\s|\\\\w|\\\\.|\\\\n/.test(literal)) continue; // regex escapes
        suspicious.push(`${path.relative(repo, full)}: ${literal.slice(0, 40)}`);
      }
    }
  };
  walk(path.join(repo, 'packages'));

  check('no hard-coded backslash paths', suspicious.length === 0, suspicious.slice(0, 3).join(' | '));
}

console.log('\n[file URLs] converted, never sliced');
{
  /*
   * `new URL(import.meta.url).pathname.slice(1)` is right on Windows and
   * wrong everywhere else. `/D:/x` becomes `D:/x`, which is what you want;
   * `/Users/x` becomes the RELATIVE `Users/x`, which resolves against the
   * working directory and reads the wrong file — or none at all.
   *
   * Written once, in one suite, it passed here and failed on macOS and
   * Linux, and CI was the only thing that could have told me. This is the
   * static half of that lesson, so the next one costs two local minutes
   * rather than a ten-minute round trip and a red build.
   */
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (/\.(mjs|cjs|tsx?)$/.test(entry.name)) {
        /*
         * Comments stripped first, and this file skipped.
         *
         * Both name the pattern in order to explain or detect it, and a
         * check that fails on its own explanation is the same trap as the
         * guard that reported its own source — which is what sent me here.
         */
        if (full === fileURLToPath(import.meta.url)) continue;

        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');

        if (/\.pathname\.slice\(/.test(code)) offenders.push(path.relative(repo, full));
      }
    }
  };

  for (const top of ['examples', 'scripts', 'packages', 'apps']) {
    const dir = path.join(repo, top);
    if (fs.existsSync(dir)) scan(dir);
  }

  check('use fileURLToPath, not pathname.slice', offenders.length === 0, offenders.join(', '));
}

console.log('\n[guards] the local check and CI exclude the same files');
{
  /*
   * The provenance grep lives in two places — `scripts/verify.mjs` for the
   * local run, `ci.yml` for the remote one — and they drifted. CI excluded
   * the workflow that names the patterns but not the SCRIPT that names
   * them, so every CI run failed on the guard's own source code while
   * `npm run verify` passed. A comment in verify.mjs asserted that the two
   * had "the same shape and the same exclusion". It was untrue, and nothing
   * checked it: two records of one fact, drifted, which is the bug class
   * this project keeps meeting.
   */
  const verify = fs.readFileSync(path.join(repo, 'scripts/verify.mjs'), 'utf8');
  const ci = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');

  /*
   * The pattern is EXTRACTED from one file and looked for in the other,
   * never spelled here.
   *
   * Writing it out would put the identifiers into a third file, and the
   * guard would then report this test — which is the very trap being
   * checked for, made once more. Derive, do not duplicate.
   */
  const fromVerify = verify.match(/'([A-Za-z-]+\|[A-Za-z|-]+)'/)?.[1];
  check('the local guard names a pattern', Boolean(fromVerify), fromVerify);
  check('and CI looks for the same one', Boolean(fromVerify) && ci.includes(fromVerify));

  // Both name the patterns, so both must exclude both, or one reports the
  // other — in whichever direction the omission happens to fall.
  check('verify excludes the workflow', verify.includes('.github/workflows/ci.yml'));
  check('verify excludes itself', verify.includes('scripts/verify.mjs'));
  check('CI excludes the workflow', ci.includes(":!.github/workflows/ci.yml"));
  check('CI excludes the verify script', ci.includes(':!scripts/verify.mjs'),
    'CI will fail on the guard\u2019s own source');
}

console.log('');
if (failures) {
  console.error(`PLATFORM-AUDIT TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('PLATFORM-AUDIT TEST PASSED');
console.log('(Static checks only — running on macOS and Linux is still CI\'s job.)\n');
