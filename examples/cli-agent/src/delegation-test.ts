/**
 * delegation-test.ts — guards agent-to-agent delegation.
 *
 * Delegation is the feature most able to cause real harm: an unbounded chain
 * burns API credit in a loop, and a naive implementation lets a restricted
 * agent escalate its own permissions by asking a permissive agent to act for
 * it. Every assertion here corresponds to a specific way that goes wrong.
 *
 * Run: npm run test:delegation --workspace @wispcrew/examples-cli
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '@wispcrew/runtime';
import {
  isTerminal,
  MAX_CALLS_PER_TURN,
  MAX_DEPTH,
  makeAskAgentTool,
  narrowPolicy,
  rootContext,
  TERMINAL_NOTICE,
  type DelegationContext,
} from '@wispcrew/runtime';
import type { ApprovalPolicy, ToolContext } from '@wispcrew/shared';

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

/** Tool context stub — delegation never touches the filesystem itself. */
const ctx: ToolContext = {
  workspaceRoot: process.cwd(),
  defaultTimeoutMs: 30_000,
  requestApproval: async () => true,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-deleg-'));
store.initStore(dir);

// Three agents to delegate between.
const alice = store.createAgent({ name: 'Alice' });
const bob = store.createAgent({ name: 'Bob', description: 'Writes prose' });
const carol = store.createAgent({ name: 'Carol' });

async function main(): Promise<void> {
  console.log('\n[policy] a delegate never gains permission');
  {
    // This is the privilege-escalation guard: a read-only agent must not be
    // able to run a shell command by asking a permissive agent to do it.
    eq('readonly caller forces readonly', narrowPolicy('readonly', 'auto'), 'readonly');
    eq('readonly caller over ask', narrowPolicy('readonly', 'ask'), 'readonly');
    eq('ask caller downgrades auto', narrowPolicy('ask', 'auto'), 'ask');
    eq('ask caller keeps readonly', narrowPolicy('ask', 'readonly'), 'readonly');
    // A permissive caller does not force permissiveness on a strict callee.
    eq('auto caller respects readonly callee', narrowPolicy('auto', 'readonly'), 'readonly');
    eq('auto caller respects ask callee', narrowPolicy('auto', 'ask'), 'ask');
    eq('auto with auto stays auto', narrowPolicy('auto', 'auto'), 'auto');
  }

  console.log('\n[roster] the tool only offers valid targets');
  {
    const c = rootContext('ask', alice.id);
    const tool = makeAskAgentTool(alice.id, c, async () => 'done');
    check('tool exists when peers exist', tool !== null);
    const desc = tool?.definition.description ?? '';
    check('lists Bob', desc.includes('Bob'));
    check('lists Carol', desc.includes('Carol'));
    check('does not list the caller', !desc.includes('"Alice"'));
    check('includes peer descriptions', desc.includes('Writes prose'));
  }

  console.log('\n[cycles] an agent already in the chain is not offered');
  {
    // Alice -> Bob, now Bob may reach Carol but must not reach Alice.
    const c: DelegationContext = {
      depth: 1,
      stack: [alice.id, bob.id],
      callsUsed: { count: 0 },
      policy: 'ask',
    };
    const tool = makeAskAgentTool(bob.id, c, async () => 'done');
    const desc = tool?.definition.description ?? '';
    check('Carol still available', desc.includes('Carol'));
    check('Alice excluded (would be a cycle)', !desc.includes('"Alice"'));
  }

  console.log('\n[depth] the chain is bounded');
  {
    const atLimit: DelegationContext = {
      depth: MAX_DEPTH,
      stack: [alice.id],
      callsUsed: { count: 0 },
      policy: 'ask',
    };
    eq(
      `no tool at depth ${MAX_DEPTH}`,
      makeAskAgentTool(alice.id, atLimit, async () => 'x'),
      null,
    );

    const below: DelegationContext = {
      depth: MAX_DEPTH - 1,
      stack: [alice.id],
      callsUsed: { count: 0 },
      policy: 'ask',
    };
    check(`tool present at depth ${MAX_DEPTH - 1}`, makeAskAgentTool(alice.id, below, async () => 'x') !== null);
  }

  console.log('\n[fan-out] one turn cannot spawn unlimited delegations');
  {
    const c = rootContext('ask', alice.id);
    let invocations = 0;
    const tool = makeAskAgentTool(alice.id, c, async () => {
      invocations++;
      return 'ok';
    })!;

    for (let i = 0; i < MAX_CALLS_PER_TURN; i++) {
      const r = await tool.run({ agent: 'Bob', task: `task ${i}` }, ctx);
      check(`call ${i + 1} succeeds`, r.ok);
    }
    const overflow = await tool.run({ agent: 'Bob', task: 'one too many' }, ctx);
    eq('call beyond the limit fails', overflow.ok, false);
    eq('limit error code', overflow.errorCode, 'limit');
    eq(`runner invoked exactly ${MAX_CALLS_PER_TURN}x`, invocations, MAX_CALLS_PER_TURN);
  }

  console.log('\n[errors] bad input fails cleanly, never silently');
  {
    const c = rootContext('ask', alice.id);
    const tool = makeAskAgentTool(alice.id, c, async () => 'ok')!;

    const unknown = await tool.run({ agent: 'Nobody', task: 'x' }, ctx);
    eq('unknown agent rejected', unknown.ok, false);
    eq('unknown agent code', unknown.errorCode, 'unknown_agent');
    check('error names the valid options', unknown.content.includes('Bob'));

    const empty = await tool.run({ agent: 'Bob', task: '   ' }, ctx);
    eq('empty task rejected', empty.ok, false);

    // Self-delegation is impossible because the caller is never in the roster.
    const self = await tool.run({ agent: 'Alice', task: 'do it yourself' }, ctx);
    eq('self-delegation rejected', self.ok, false);

    // Name matching should be forgiving about case/whitespace, not brittle.
    const cased = await tool.run({ agent: '  bOb  ', task: 'fine' }, ctx);
    eq('name match is case/space tolerant', cased.ok, true);
  }

  console.log('\n[failure] a delegate that throws does not kill the caller');
  {
    const c = rootContext('ask', alice.id);
    const tool = makeAskAgentTool(alice.id, c, async () => {
      throw new Error('delegate exploded');
    })!;
    const r = await tool.run({ agent: 'Bob', task: 'x' }, ctx);
    eq('failure reported as a tool error', r.ok, false);
    eq('failure code', r.errorCode, 'delegate_failed');
    check('failure message is surfaced', r.content.includes('delegate exploded'));
  }

  console.log('\n[result] the answer comes back attributed');
  {
    const c = rootContext('ask', alice.id);
    const tool = makeAskAgentTool(alice.id, c, async (id, task) => `handled: ${task} (${id})`)!;
    const r = await tool.run({ agent: 'Bob', task: 'summarize' }, ctx);
    check('succeeds', r.ok);
    check('names the responding agent', r.content.includes('Bob'));
    check('carries the answer', r.content.includes('handled: summarize'));
    eq('structured agent id returned', (r.data as { agentId?: string })?.agentId, bob.id);
  }

  console.log('\n[isolation] archived agents are not delegation targets');
  {
    store.updateAgent(carol.id, { archived: true });
    const c = rootContext('ask', alice.id);
    const desc = makeAskAgentTool(alice.id, c, async () => 'x')?.definition.description ?? '';
    check('archived agent hidden', !desc.includes('Carol'));
    store.updateAgent(carol.id, { archived: false });
  }

  console.log('\n[terminal] the last agent in a chain is told so');
  {
    // Observed live: a pair of agents each instructed to "always delegate"
    // terminated safely, but the final one echoed the request instead of
    // answering, because its ask_agent tool had silently disappeared.
    const deep: DelegationContext = {
      depth: MAX_DEPTH,
      stack: [alice.id],
      callsUsed: { count: 0 },
      policy: 'ask',
    };
    eq('terminal at max depth', isTerminal(alice.id, deep), true);

    const exhausted: DelegationContext = {
      depth: 0,
      stack: [alice.id],
      callsUsed: { count: MAX_CALLS_PER_TURN },
      policy: 'ask',
    };
    eq('terminal when fan-out is spent', isTerminal(alice.id, exhausted), true);

    // Only peer already on the stack ⇒ nobody left to ask.
    const cornered: DelegationContext = {
      depth: 1,
      stack: [alice.id, bob.id, carol.id],
      callsUsed: { count: 0 },
      policy: 'ask',
    };
    eq('terminal when every peer is on the stack', isTerminal(bob.id, cornered), true);

    const open = rootContext('ask', alice.id);
    eq('not terminal with peers and headroom', isTerminal(alice.id, open), false);

    check('notice tells the agent to answer itself', TERMINAL_NOTICE.includes('Answer it yourself'));
  }

  console.log('\n[store] a malformed store degrades instead of bricking the app');
  {
    // Found the hard way: a bare object where an array belonged reached the
    // renderer and blanked the window with "find is not a function". These
    // files are plain JSON so users can hand-edit them, so malformed input is
    // a normal condition — it must never take the UI down.
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-broken-'));
    store.initStore(broken);
    const agentsFile = path.join(broken, 'agents.json');

    // A single object (what PowerShell's ConvertTo-Json produces from a
    // one-element array) is promoted rather than discarded.
    fs.writeFileSync(agentsFile, JSON.stringify({ id: 'a1', name: 'Solo', createdAt: 1, updatedAt: 1 }));
    const promoted = store.listAgents();
    check('bare object is promoted to a one-element array', Array.isArray(promoted));
    eq('promoted length', promoted.length, 1);
    eq('promoted content preserved', promoted[0]?.name, 'Solo');

    for (const [label, contents] of [
      ['garbage', 'not json at all'],
      ['a number', '42'],
      ['a string', '"hello"'],
      ['null', 'null'],
      ['empty file', ''],
    ] as const) {
      fs.writeFileSync(agentsFile, contents);
      const got = store.listAgents();
      check(`${label} yields an array`, Array.isArray(got));
      eq(`${label} yields empty`, got.length, 0);
    }

    // A BOM must still parse — Windows tooling writes them.
    fs.writeFileSync(agentsFile, '\uFEFF' + JSON.stringify([{ id: 'b1', name: 'Bom', createdAt: 1, updatedAt: 1 }]));
    eq('BOM-prefixed array still reads', store.listAgents().length, 1);

    fs.rmSync(broken, { recursive: true, force: true });
    store.initStore(dir);
  }

  console.log('\n[solo] a lone agent gets no delegation tool');
  {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-solo-'));
    store.initStore(solo);
    const only = store.createAgent({ name: 'Only' });
    const c = rootContext('ask', only.id);
    eq('no tool with no peers', makeAskAgentTool(only.id, c, async () => 'x'), null);
    fs.rmSync(solo, { recursive: true, force: true });
    store.initStore(dir);
  }

  console.log('');
  if (failures > 0) {
    console.error(`DELEGATION TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('DELEGATION TEST PASSED\n');
}

main()
  .catch((err) => {
    console.error('DELEGATION TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

/** Referenced for its type only. */
export type { ApprovalPolicy };
