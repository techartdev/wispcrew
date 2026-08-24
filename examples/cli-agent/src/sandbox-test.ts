/**
 * sandbox-test.ts — guards the filesystem confinement boundary.
 *
 * The workspace root is the main thing standing between an agent and the
 * user's entire disk. Every assertion here is an escape someone might
 * actually attempt, or a platform difference that could quietly weaken the
 * check:
 *
 *  - `..` traversal, in shallow and deep forms
 *  - absolute paths outside the root
 *  - re-joining tricks (`sub/../../outside`)
 *  - **prefix siblings** — a root of `/x/Work` must not expose `/x/Workspace`,
 *    which a naive `startsWith(root)` (without the separator) would allow
 *  - case variants, which matter because Windows and macOS have
 *    case-insensitive filesystems while Linux does not
 *  - NUL bytes, which historically truncate paths in native layers
 *
 * Run: npm run test:sandbox --workspace @ghostbot/examples-cli
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool, writeFileTool, listDirTool } from '@ghostbot/tools';
import type { ToolContext } from '@ghostbot/shared';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sandbox-'));

async function main(): Promise<void> {
  // Workspace deliberately named so a sibling shares its prefix.
  const ws = path.join(base, 'Work');
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'mine.txt'), 'MINE');
  fs.writeFileSync(path.join(ws, 'sub', 'deep.txt'), 'DEEP');

  const sibling = path.join(base, 'Workspace');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SHOULD-NOT-LEAK');

  const ctx: ToolContext = {
    workspaceRoot: ws,
    defaultTimeoutMs: 5_000,
    requestApproval: async () => true,
  };

  console.log('\n[allow] legitimate paths inside the workspace');
  {
    for (const [label, p] of [
      ['plain relative', 'mine.txt'],
      ['dot-prefixed', './mine.txt'],
      ['forward-slash subpath', 'sub/deep.txt'],
      ['the root itself', '.'],
    ] as const) {
      const r = await readFileTool.run({ path: p }, ctx);
      check(label, r.ok, r.content.slice(0, 120));
    }

    // Native separators must work on the platform that uses them.
    const native = await readFileTool.run({ path: `sub${path.sep}deep.txt` }, ctx);
    check('native separator subpath', native.ok);
  }

  console.log('\n[deny] traversal and absolute escapes');
  {
    const escapes: Array<[string, string]> = [
      ['single parent', '../Workspace/secret.txt'],
      ['deep parent', '../../../../../../etc/passwd'],
      ['re-join trick', 'sub/../../Workspace/secret.txt'],
      ['absolute sibling', path.join(sibling, 'secret.txt')],
      ['absolute root', process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'],
      ['bare parent dir', '..'],
    ];
    for (const [label, p] of escapes) {
      const r = await readFileTool.run({ path: p }, ctx);
      const leaked = r.ok && r.content.includes('SHOULD-NOT-LEAK');
      check(`${label} blocked`, !r.ok || !leaked, `ok=${r.ok}`);
      check(`${label} did not leak`, !leaked);
    }
  }

  console.log('\n[deny] prefix-sibling confusion');
  {
    // The classic bug: `startsWith(root)` without the separator lets a root of
    // ".../Work" reach ".../Workspace". The separator is what prevents it.
    const r = await readFileTool.run({ path: path.join('..', 'Workspace', 'secret.txt') }, ctx);
    check('sibling sharing a name prefix is unreachable', !r.ok || !r.content.includes('SHOULD-NOT-LEAK'));
  }

  console.log('\n[deny] case variants cannot widen the boundary');
  {
    // On Windows/macOS these resolve to real files; the check must not be
    // fooled into treating an outside path as inside.
    const upperSibling = path.join(sibling, 'secret.txt').toUpperCase();
    const r = await readFileTool.run({ path: upperSibling }, ctx);
    check('upper-cased absolute sibling blocked', !r.ok || !r.content.includes('SHOULD-NOT-LEAK'));

    const upperRel = await readFileTool.run({ path: '../WORKSPACE/secret.txt' }, ctx);
    check('upper-cased relative sibling blocked', !upperRel.ok || !upperRel.content.includes('SHOULD-NOT-LEAK'));
  }

  console.log('\n[deny] NUL bytes');
  {
    const r = await readFileTool.run({ path: 'mine.txt\u0000.png' }, ctx);
    check('NUL-embedded path rejected', !r.ok);
  }

  console.log('\n[deny] writes obey the same boundary');
  {
    const outside = path.join(base, 'escaped.txt');
    const r = await writeFileTool.run({ path: '../escaped.txt', content: 'nope' }, ctx);
    check('write outside the root fails', !r.ok);
    check('no file was created outside', !fs.existsSync(outside));

    const abs = await writeFileTool.run({ path: path.join(sibling, 'planted.txt'), content: 'nope' }, ctx);
    check('absolute write outside fails', !abs.ok);
    check('nothing planted in the sibling', !fs.existsSync(path.join(sibling, 'planted.txt')));

    const inside = await writeFileTool.run({ path: 'allowed.txt', content: 'yes' }, ctx);
    check('write inside the root succeeds', inside.ok);
  }

  console.log('\n[deny] listing cannot enumerate outside');
  {
    const r = await listDirTool.run({ path: '..' }, ctx);
    check('listing the parent fails', !r.ok);
    const abs = await listDirTool.run({ path: sibling }, ctx);
    check('listing an absolute sibling fails', !abs.ok);
  }

  console.log('');
  if (failures > 0) {
    console.error(`SANDBOX TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('SANDBOX TEST PASSED\n');
}

main()
  .catch((err) => {
    console.error('SANDBOX TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
