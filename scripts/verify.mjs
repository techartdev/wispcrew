/**
 * verify.mjs — everything CI checks that a local machine can check.
 *
 * Written after exhausting a month of GitHub Actions minutes on runs that
 * mostly re-confirmed what the offline suites already knew. CI is worth
 * spending on exactly one thing this machine cannot do: judging macOS and
 * Linux. Everything else belongs here, where it costs nothing.
 *
 *   node scripts/verify.mjs
 *
 * Exits non-zero on the first hard failure, so it can gate a commit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;

const run = (label, file, args) => {
  process.stdout.write(`${label.padEnd(34)}`);
  try {
    /*
     * A generous buffer, because the default is 1 MB and a full build
     * comfortably exceeds it. Overflowing kills the child and reports
     * `status: null` with empty stderr — which looks exactly like a failing
     * build and is not one. That cost a confusing few minutes.
     */
    execFileSync(file, args, {
      cwd: repo,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      /*
       * A shell is needed only for `.cmd` wrappers: Node refuses to spawn
       * one directly on Windows and fails with EINVAL, which surfaces as an
       * empty error that looks like a failing build.
       *
       * It must NOT be used otherwise. Under a shell, `C:\Program
       * Files\nodejs\node.exe` is split at the space and the command becomes
       * "'C:\Program' is not recognized" — the same quoting bug this project
       * already fixed once in its shell tool.
       */
      shell: process.platform === 'win32' && file.endsWith('.cmd'),
    });
    console.log('ok');
    return true;
  } catch (err) {
    console.log('FAILED');
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // Only the interesting lines: a full build log buries the cause.
    const lines = output
      .split('\n')
      .filter((l) => /error|FAIL|✗|not recognized/i.test(l))
      .slice(0, 8);
    for (const line of lines) console.log(`    ${line.trim()}`);
    failed++;
    return false;
  }
};

const check = (label, ok, detail) => {
  process.stdout.write(`${label.padEnd(34)}`);
  if (ok) {
    console.log('ok');
  } else {
    console.log(`FAILED${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};

console.log('\nWispCrew — local verification\n');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run('typecheck', npm, ['run', 'typecheck']);
run('build', npm, ['run', 'build']);
run('offline suites', npm, ['run', 'test', '--workspace', '@wispcrew/examples-cli']);
run('encoding', process.execPath, ['scripts/fix-encoding.mjs', '--check']);

/*
 * Provenance guards, mirrored from CI.
 *
 * These are the reason the project can be MIT licensed, so they are worth
 * running on every change rather than only when a workflow happens to fire.
 */
console.log('');

const findVendorDirs = (dir, found = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.name === 'vendor') found.push(path.relative(repo, path.join(dir, entry.name)));
    findVendorDirs(path.join(dir, entry.name), found);
  }
  return found;
};

const vendored = findVendorDirs(repo);
check('no vendored trees', vendored.length === 0, vendored.join(', '));

/*
 * The checks themselves name the patterns they look for, so they must be
 * excluded or every run reports a false positive on its own source. CI has
 * the same shape and the same exclusion.
 */
const SELF = [':(exclude).github/workflows/ci.yml', ':(exclude)scripts/verify.mjs'];

let proprietary = '';
try {
  proprietary = execFileSync(
    'git',
    ['grep', '-nEI', 'Anysphere|sand-protocol|dune-rpc', '--', '.', ...SELF],
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' },
  );
} catch {
  // git grep exits non-zero when nothing matches, which is the good case.
}
check('no proprietary identifiers', proprietary.trim() === '', proprietary.split('\n')[0]);

/*
 * Secrets. The staged-diff scan happens at commit time, but a key sitting in
 * a tracked file would survive that, so look at the whole tree.
 */
/*
 * Real credentials are long. The test fixture `sk-ant-oat01-borrowed` is
 * short and deliberate, so the pattern requires enough trailing characters
 * to distinguish a key from a placeholder — a check that cries wolf on a
 * fixture is a check people learn to ignore.
 */
let keys = '';
try {
  keys = execFileSync(
    'git',
    [
      'grep',
      '-nEI',
      'sk-ant-oat01-[A-Za-z0-9_-]{30}|nvapi-[A-Za-z0-9_-]{30}|sk-proj-[A-Za-z0-9_-]{30}',
      '--',
      '.',
      ...SELF,
    ],
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' },
  );
} catch {
  /* no matches */
}
check('no credentials in tracked files', keys.trim() === '', keys.split('\n')[0]);

check('LICENSE exists', fs.existsSync(path.join(repo, 'LICENSE')));

/*
 * Boot the app and confirm the window actually paints.
 *
 * The most valuable thing CI does, and it works locally too — this machine
 * simply cannot speak for macOS or Linux. A blank window is roughly 4KB of
 * PNG; a rendered one is 40KB or more, so the size is a reliable signal that
 * the renderer got past its first paint.
 *
 * Skipped with --fast, because it costs about a minute and most changes do
 * not touch the desktop app.
 */
if (!process.argv.includes('--fast')) {
  console.log('');
  process.stdout.write('app boots and paints'.padEnd(34));

  const shot = path.join(os.tmpdir(), `wispcrew-verify-${Date.now()}.png`);
  try {
    const electron = path.join(
      repo,
      'node_modules',
      'electron',
      'dist',
      process.platform === 'win32' ? 'electron.exe' : 'electron',
    );

    if (!fs.existsSync(electron)) {
      console.log('skipped — electron not installed');
    } else {
      /*
       * A throwaway profile, via Electron's own flag.
       *
       * CI needs no such thing — a fresh runner has no profile — but on a
       * developer's machine this would otherwise start a daemon against
       * their real agents and conversations. `--user-data-dir` is Chromium's
       * own switch, so it needs no support from the app.
       */
      const profile = path.join(os.tmpdir(), `wispcrew-verify-${process.pid}`);

      /*
       * `stdio: 'ignore'`, not 'pipe'.
       *
       * The app spawns a detached daemon that inherits its pipes and keeps
       * them open after the app itself exits. `execFileSync` waits for every
       * stdio stream to close, so piping meant the call hung until its
       * timeout even though the screenshot had been written seconds earlier
       * — the same trap this project already hit in its shell tool, where a
       * killed process emitted `exit` with no `close`.
       *
       * The screenshot on disk is the result; the child's output is not
       * needed.
       */
      try {
        execFileSync(electron, ['.', `--user-data-dir=${profile}`], {
          cwd: path.join(repo, 'apps', 'desktop'),
          stdio: 'ignore',
          timeout: 60_000,
          env: {
            ...process.env,
            WISPCREW_CAPTURE: shot,
            WISPCREW_CAPTURE_DELAY: '9000',
          },
        });
      } catch {
        // A non-zero exit or a timeout is judged by the screenshot below,
        // which is the thing actually being tested.
      }

      /*
       * Stop the daemon this boot started.
       *
       * It is detached by design and outlives the app, so without this every
       * verification run leaves another daemon holding a throwaway profile.
       */
      try {
        const endpoint = JSON.parse(
          fs.readFileSync(path.join(profile, 'node-endpoint.json'), 'utf8'),
        );
        if (typeof endpoint.pid === 'number') process.kill(endpoint.pid);
      } catch {
        /* no daemon, or already gone */
      }

      fs.rmSync(profile, { recursive: true, force: true });

      const size = fs.existsSync(shot) ? fs.statSync(shot).size : 0;
      if (size >= 10_000) {
        console.log(`ok (${Math.round(size / 1024)}KB)`);
      } else {
        console.log(`FAILED — ${size === 0 ? 'no screenshot' : `${size} bytes, window looks blank`}`);
        failed++;
      }
    }
  } catch (err) {
    console.log(`FAILED — ${(err.message ?? '').split('\n')[0]}`);
    failed++;
  } finally {
    fs.rmSync(shot, { force: true });
  }
}

console.log('');
if (failed > 0) {
  console.error(`${failed} check(s) failed\n`);
  process.exit(1);
}

console.log('All local checks passed.');
console.log('Not covered here: macOS and Linux, which only CI can judge.\n');
