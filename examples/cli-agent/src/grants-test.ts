/**
 * grants-test.ts — guards standing "always allow" tool permissions.
 *
 * A persisted security decision has to be exactly right in both directions:
 * too narrow and users get approval fatigue and start clicking reflexively;
 * too broad and a permission silently applies where it was never intended.
 *
 * Run: npm run test:grants --workspace @ghostbot/examples-cli
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  grant,
  initGrants,
  isGranted,
  listGrants,
  revoke,
  revokeAll,
  revokeForAgent,
} from '../../../apps/desktop/src/main/grants.js';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-grants-'));

function main(): void {
  initGrants(dir);

  console.log('\n[scope] a grant applies to exactly one agent and one tool');
  {
    grant('agentA', 'shell');
    check('granted pair is allowed', isGranted('agentA', 'shell'));
    // The two ways a grant could leak: same tool on another agent, or another
    // tool on the same agent. Both must stay closed.
    check('same tool, other agent still asks', !isGranted('agentB', 'shell'));
    check('other tool, same agent still asks', !isGranted('agentA', 'write_file'));
    check('unrelated pair still asks', !isGranted('agentB', 'write_file'));
  }

  console.log('\n[persistence] a grant survives a restart');
  {
    // Simulate a fresh process: drop the in-memory cache and reload.
    initGrants(dir);
    check('still granted after reload', isGranted('agentA', 'shell'));
    eq('exactly one grant stored', listGrants().length, 1);
    check('file exists on disk', fs.existsSync(path.join(dir, 'tool-grants.json')));
  }

  console.log('\n[idempotence] granting twice does not duplicate');
  {
    grant('agentA', 'shell');
    grant('agentA', 'shell');
    eq('still a single record', listGrants().filter((g) => g.toolName === 'shell').length, 1);
  }

  console.log('\n[revoke] individual and bulk');
  {
    grant('agentA', 'write_file');
    grant('agentB', 'shell');
    eq('three grants', listGrants().length, 3);

    revoke('agentA', 'shell');
    check('revoked pair asks again', !isGranted('agentA', 'shell'));
    check('sibling grant untouched', isGranted('agentA', 'write_file'));
    check('other agent untouched', isGranted('agentB', 'shell'));

    // Revoking something that was never granted must be a no-op, not a throw.
    revoke('agentZ', 'nothing');
    eq('no-op revoke leaves count', listGrants().length, 2);

    revokeAll();
    eq('revoke all empties the list', listGrants().length, 0);
    check('nothing is granted after revoke all', !isGranted('agentB', 'shell'));
  }

  console.log('\n[cleanup] deleting an agent drops its grants');
  {
    grant('doomed', 'shell');
    grant('doomed', 'write_file');
    grant('survivor', 'shell');
    revokeForAgent('doomed');
    check('deleted agent loses shell', !isGranted('doomed', 'shell'));
    check('deleted agent loses write_file', !isGranted('doomed', 'write_file'));
    // The important half: a recreated id must not inherit permissions, and
    // unrelated agents must not be collateral damage.
    check('other agent keeps its grant', isGranted('survivor', 'shell'));
    revokeAll();
  }

  console.log('\n[robustness] a malformed file degrades to "ask every time"');
  {
    const file = path.join(dir, 'tool-grants.json');
    for (const [label, contents] of [
      ['garbage', 'not json'],
      ['an object', '{"agentId":"a"}'],
      ['a number', '7'],
      ['null', 'null'],
      ['empty', ''],
    ] as const) {
      fs.writeFileSync(file, contents);
      initGrants(dir);
      // Failing closed is the only acceptable direction: a corrupt file must
      // never be read as "everything is allowed".
      check(`${label}: nothing granted`, !isGranted('agentA', 'shell'));
      eq(`${label}: empty list`, listGrants().length, 0);
    }

    // A partially-valid file keeps the rows it can parse and drops the rest.
    fs.writeFileSync(
      file,
      JSON.stringify([
        { agentId: 'good', toolName: 'shell', grantedAt: 123 },
        { agentId: 'missing-tool' },
        'not an object',
        { toolName: 'no-agent' },
      ]),
    );
    initGrants(dir);
    eq('only the valid row survives', listGrants().length, 1);
    check('valid row is usable', isGranted('good', 'shell'));

    // A BOM must still parse — Windows tooling writes them.
    fs.writeFileSync(
      file,
      '\uFEFF' + JSON.stringify([{ agentId: 'bom', toolName: 'shell', grantedAt: 1 }]),
    );
    initGrants(dir);
    check('BOM-prefixed file reads', isGranted('bom', 'shell'));
  }

  console.log('\n[metadata] grants carry a timestamp for the UI');
  {
    revokeAll();
    const before = Date.now();
    grant('agentA', 'shell');
    const g = listGrants()[0];
    check('timestamp recorded', typeof g?.grantedAt === 'number');
    check('timestamp is sane', (g?.grantedAt ?? 0) >= before);
  }

  console.log('');
  if (failures > 0) {
    console.error(`GRANTS TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('GRANTS TEST PASSED\n');
}

try {
  main();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
