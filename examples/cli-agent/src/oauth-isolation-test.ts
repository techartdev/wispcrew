/**
 * oauth-isolation-test.ts — one vendor's sign-in never disturbs another's.
 *
 * A user reported that "ChatGPT sign in kicked the Claude oauth", and that a
 * Claude sign-in ended their VS Code Claude extension session. Those are two
 * different failures and only one is WispCrew's to fix:
 *
 *  - The VS Code conflict is provider-side: WispCrew's Claude flow uses the
 *    SAME public Anthropic OAuth client as Claude Code and the extensions,
 *    and a new grant retires the previous one server-side. Nothing local can
 *    prevent that; the UI warns instead.
 *
 *  - The ChatGPT-vs-Claude conflict WOULD be a WispCrew bug if the two
 *    vendors shared a storage slot, a refresh chain, or a redirect. This
 *    suite pins that they do not, so a regression that reintroduces the
 *    collision fails here rather than on a user's machine.
 *
 * Offline: no network, no credentials.
 */
import { createNodeCrypto, getSecret, saveCredential, setHost, signOut, upsertSecrets } from '@wispcrew/runtime';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-oauth-iso-'));
  setHost({ dataDir: dir, defaultWorkspaceRoot: dir, nodeName: 't', crypto: createNodeCrypto(dir) });

  const CLAUDE = 'WISPCREW_OAUTH_ANTHROPIC';
  const CHATGPT = 'WISPCREW_OAUTH_CHATGPT';

  console.log('\n[distinct slots] each vendor writes its own key');
  {
    saveCredential(dir, 'anthropic', { type: 'oauth', access: 'claude-access', refresh: 'claude-refresh', expires: Date.now() + 1000 });
    saveCredential(dir, 'chatgpt', { type: 'oauth', access: 'gpt-access', refresh: 'gpt-refresh', expires: Date.now() + 1000 });

    check('both are stored', getSecret(dir, CLAUDE) !== undefined && getSecret(dir, CHATGPT) !== undefined);
    check('claude value is intact', getSecret(dir, CLAUDE)!.includes('claude-access'));
    check('chatgpt value is intact', getSecret(dir, CHATGPT)!.includes('gpt-access'));

    // Re-saving one vendor must not touch the other — the whole-point case.
    saveCredential(dir, 'chatgpt', { type: 'oauth', access: 'gpt-access-2', refresh: 'gpt-refresh-2', expires: Date.now() + 2000 });
    check('re-signing chatgpt keeps claude', getSecret(dir, CLAUDE)!.includes('claude-access'));
    check('and updates chatgpt', getSecret(dir, CHATGPT)!.includes('gpt-access-2'));
  }

  console.log('\n[sign-out] removes only the named vendor');
  {
    signOut(dir, 'chatgpt');
    check('claude survives a chatgpt sign-out', getSecret(dir, CLAUDE) !== undefined);
    check('chatgpt is gone', getSecret(dir, CHATGPT) === undefined);

    // And the reverse, so the asymmetry cannot hide a one-directional bug.
    saveCredential(dir, 'chatgpt', { type: 'oauth', access: 'gpt-access-3', refresh: 'gpt-refresh-3', expires: Date.now() + 1000 });
    signOut(dir, 'anthropic');
    check('chatgpt survives a claude sign-out', getSecret(dir, CHATGPT) !== undefined);
    check('claude is gone', getSecret(dir, CLAUDE) === undefined);
  }

  console.log('\n[raw upsert] a foreign key passes through untouched');
  {
    // The API key path and the OAuth path share one store. Signing in to a
    // vendor must not flatten a provider API key into the void either.
    upsertSecrets(dir, [{ key: 'WISPCREW_KEY_OPENAI', value: 'sk-abc' }]);
    saveCredential(dir, 'anthropic', { type: 'oauth', access: 'claude-access-4', refresh: 'claude-refresh-4', expires: Date.now() + 1000 });
    check('an API key survives an OAuth sign-in', getSecret(dir, 'WISPCREW_KEY_OPENAI') === 'sk-abc');
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('');
  if (failures > 0) {
    console.error(`OAUTH-ISOLATION TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('OAUTH-ISOLATION TEST PASSED\n');
}

main();
