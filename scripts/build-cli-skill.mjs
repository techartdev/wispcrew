/**
 * build-cli-skill.mjs — write the WispCrew CLI skill from the real command table.
 *
 * GENERATED, not written by hand. A hand-written CLI reference is a second
 * source of truth that begins drifting the day a flag changes, and an agent
 * confidently using a command that no longer exists is worse than one with
 * no skill at all. This reads `wispcrew capabilities --json` — the same
 * surface any other program would use — so the skill cannot describe a CLI
 * that is not there.
 *
 * The shape is a TREE on purpose. Everything in a skill's body is spent on
 * every invocation whether it was needed or not, so fifty commands injected
 * whole would crowd out the conversation they were meant to help with. The
 * overview carries what is always worth having; the rest sits in sections
 * the agent reads with `read_skill` only when they apply.
 *
 *   node scripts/build-cli-skill.mjs > skills/wispcrew-cli.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const capabilities = JSON.parse(
  execFileSync(
    process.execPath,
    [path.join(repo, 'apps/daemon/dist/cli.js'), 'capabilities', '--json'],
    { encoding: 'utf8' },
  ),
);

const commands = capabilities.commands ?? [];
if (commands.length === 0) throw new Error('capabilities reported no commands');

/**
 * Which section each command belongs to.
 *
 * Grouped by the question somebody is asking, not by the noun in the
 * command name: a person wanting to know why an agent is not answering
 * looks for "troubleshooting", and should find `status`, `logs` and `test`
 * together there.
 */
const SECTIONS = [
  {
    name: 'agents',
    description: 'Create, inspect, configure and remove agents; their model and workspace.',
    match: (n) => n.startsWith('agents'),
  },
  {
    name: 'talking',
    description: 'Send a message and read the reply; transcripts, rewind, branch, history.',
    match: (n) => /^(ask|say|chat|transcript|history|rewind|branch|clear|rooms?)\b/.test(n),
  },
  {
    name: 'automation',
    description: 'Cron routines, file watches, self-scheduled follow-ups and their runs.',
    match: (n) => /^(routines?|tasks?|watch|schedule)\b/.test(n),
  },
  {
    name: 'approvals',
    description: 'Answering a tool that needs permission, and standing grants.',
    match: (n) => /^(approvals?|grants?)\b/.test(n),
  },
  {
    name: 'machines',
    description: 'Pairing another machine, listing nodes, and serving this engine.',
    match: (n) => /^(nodes?|pair|serve|daemon|stop)\b/.test(n),
  },
  {
    name: 'setup',
    description: 'Providers, models, keys, Telegram, skills and MCP plugins.',
    match: (n) =>
      /^(configure|settings|providers?|models?|skills?|mcp|plugins?|telegram|login|logout|notify)\b/.test(n),
  },
  {
    name: 'troubleshooting',
    description: 'When something is not answering: status, logs, and testing a provider.',
    match: (n) => /^(status|logs?|test|doctor|version|capabilities)\b/.test(n),
  },
];

const sectionFor = (name) => SECTIONS.find((s) => s.match(name))?.name ?? 'setup';

/** One command, as a reference entry. */
function render(spec) {
  const lines = [`### \`wispcrew ${spec.name}\``];
  if (spec.summary) lines.push('', spec.summary);

  const args = spec.args ?? [];
  if (args.length) {
    lines.push('', ...args.map((a) => {
      const flag = a.flag ?? a.name ?? String(a);
      const summary = a.summary ?? a.description ?? '';
      return `- \`${flag}\`${summary ? ` — ${summary}` : ''}`;
    }));
  }

  // What a caller gets back matters more than the prose when the caller is
  // a program deciding what to do next.
  if (spec.returns) lines.push('', `Returns: ${spec.returns}`);

  return lines.join('\n');
}

const grouped = new Map(SECTIONS.map((s) => [s.name, []]));
for (const spec of commands) grouped.get(sectionFor(spec.name)).push(spec);

const sections = SECTIONS.filter((s) => grouped.get(s.name).length > 0).map((s) => ({
  name: s.name,
  description: s.description,
  body: [
    `# wispcrew — ${s.name}`,
    '',
    s.description,
    '',
    grouped.get(s.name).map(render).join('\n\n'),
  ].join('\n'),
}));

/*
 * The overview is charged for on every invocation, so it stays short. Its
 * job is to make the agent competent at the common case and aware of where
 * everything else lives — not to teach the whole CLI.
 */
const body = `# The wispcrew command line

You are running inside WispCrew, and \`wispcrew\` is its command line. It
speaks to the same engine the desktop app uses, over the same protocol, so
anything you do here shows up in the app immediately and the reverse.

Run it with your shell tool.

## Worth knowing without looking anything up

\`\`\`
wispcrew agents                 # what lives on this machine
wispcrew ask <agent> "..."      # send a message, wait for the reply
wispcrew status                 # is the engine up, and on which profile
wispcrew capabilities --json    # the entire surface, for a program
\`\`\`

## Two things that will bite you

**\`--json\` works on almost everything.** Parse that, never the table — the
columns are meant for people and are free to change; the JSON is not.

**Every command needs a running engine.** Without one you get "No WispCrew
daemon is running for this profile". Start it with \`wispcrew serve\`, and add
\`--listen\` if anything other than this machine needs to reach it.

## Do not guess a flag

There are ${commands.length} commands, grouped below. Read the section that
covers what you are doing, or run \`wispcrew <command> --help\`. An invented
flag usually fails loudly; an invented VALUE quietly does the wrong thing.`;

/*
 * Written here rather than to stdout.
 *
 * PowerShell's `>` re-encodes as UTF-16 with a BOM, which produced a file
 * that looked right in an editor and would not parse. The readers here are
 * BOM-tolerant (hard rule 7) but nothing should have to be.
 */
const out = path.join(repo, 'skills', 'wispcrew-cli.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      name: 'wispcrew-cli',
      description:
        'How to drive WispCrew from its command line: agents, conversations, ' +
        'routines, approvals, paired machines, setup and troubleshooting.',
      body,
      sections,
      enabled: true,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.error(`wrote ${out} — ${sections.length} sections, ${commands.length} commands`);
