/*
 * speaker-labels-test.mjs — in a room, the model is told who said what.
 *
 * Every chat API has exactly one `assistant` role. A room transcript knows
 * perfectly well who wrote each message, and `rebuildHistory` threw that away
 * on the way to the provider, so several agents arrived as one anonymous
 * voice. Two failures came straight out of it, both observed live:
 *
 *   - An agent read its own previous message as a colleague's, described its
 *     own plan in the third person, and waited for itself to reply.
 *   - It could not distinguish a task assigned TO it from its own
 *     acknowledgement of that task, so the work sat unowned while it waited.
 *
 * Both were reported as the model being confused about its identity. It was
 * not confused; the information had been deleted before it arrived. A prompt
 * fix was attempted first and could not have worked -- it said "the member
 * marked you is you" while no message carried an author at all.
 *
 * `authorId` had been recorded on every room message for months. The comment
 * in branching.ts even cited it as an example of the declared-but-never-read
 * fault, while itself being the code that dropped it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildHistory, stripSpeakerLabel } from '@wispcrew/runtime';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
};

const A = 'agent_a';
const B = 'agent_b';
const handles = { [A]: 'alice', [B]: 'bob' };
const nameFor = (id) => handles[id];

const entries = [
  { kind: 'message', id: 'm1', role: 'user', content: 'both of you, plan this', createdAt: 1 },
  { kind: 'message', id: 'm2', role: 'assistant', authorId: A, content: 'I will take the parser.', createdAt: 2 },
  { kind: 'message', id: 'm3', role: 'assistant', authorId: B, content: '@alice you own the parser then.', createdAt: 3 },
];

console.log('\n[1] a colleague is named, and you are not');
{
  const asA = rebuildHistory(entries, { selfId: A, nameFor, inline: true });
  const mine = asA.find((m) => m.content.includes('I will take the parser'));
  const theirs = asA.find((m) => m.content.includes('you own the parser'));

  check('my own message is unlabelled', mine && !mine.content.startsWith('[@'), mine?.content);
  check('my colleague is labelled', theirs && theirs.content.startsWith('[@bob] '), theirs?.content);
}

console.log('\n[2] the labels flip with the reader');
{
  const asB = rebuildHistory(entries, { selfId: B, nameFor, inline: true });
  const alices = asB.find((m) => m.content.includes('I will take the parser'));
  const own = asB.find((m) => m.content.includes('you own the parser'));

  check('the other agent is now the labelled one', alices?.content.startsWith('[@alice] '), alices?.content);
  check('and B sees its own words plain', own && !own.content.startsWith('[@'), own?.content);
}

console.log('\n[3] a one-to-one chat is untouched');
{
  /*
   * One assistant needs no attribution, and labelling it would teach the
   * model to write its own handle into replies. Omitting `speakers` is how
   * a solo conversation opts out, so it must change nothing at all.
   */
  const solo = rebuildHistory(entries);
  check('no labels anywhere', solo.every((m) => !String(m.content).startsWith('[@')));
}

console.log('\n[4] the user is never labelled');
{
  const asA = rebuildHistory(entries, { selfId: A, nameFor, inline: true });
  const user = asA.find((m) => m.role === 'user');
  check("the person's words are their own", user?.content === 'both of you, plan this', user?.content);
}

console.log('\n[5] an unknown author is not guessed at');
{
  /*
   * A departed agent still has messages in the history. Inventing a handle
   * for it, or printing a raw id, is worse than saying nothing.
   */
  const withGhost = [
    ...entries,
    { kind: 'message', id: 'm4', role: 'assistant', authorId: 'agent_gone', content: 'from before.', createdAt: 4 },
  ];
  const built = rebuildHistory(withGhost, { selfId: A, nameFor, inline: true });
  const ghost = built.find((m) => m.content.includes('from before'));
  check('no label, no raw id', ghost?.content === 'from before.', ghost?.content);
}

console.log('\n[6] labelling survives alongside the channel marker');
{
  const viaEntries = [
    { kind: 'message', id: 'v1', role: 'user', via: 'telegram', content: 'from my phone', createdAt: 1 },
    { kind: 'message', id: 'v2', role: 'assistant', authorId: B, content: 'on it', createdAt: 2 },
  ];
  const built = rebuildHistory(viaEntries, { selfId: A, nameFor, inline: true });
  check('the channel marker still works', built[0]?.content === '[via telegram] from my phone', built[0]?.content);
  check('and the speaker label too', built[1]?.content === '[@bob] on it', built[1]?.content);
}

console.log("\n[7] a colleague's tool calls are not your memory");
{
  /*
   * The larger half of the bug. Tool entries carried no author at all, so
   * in a room every agent received every OTHER agent's calls as
   * unattributed assistant turns -- the exact shape of its own work. In the
   * room where this was found: 453 tool entries, none with an author. One
   * agent was effectively handed several hundred commands it had never run,
   * and could no longer tell a task assigned to it from its own reply,
   * because the turns surrounding that assignment all looked like its own.
   *
   * Dropped rather than labelled, unlike prose: a tool call is a request
   * with a matching result, and a request the model never made carrying
   * output it never received is a false memory however it is worded.
   */
  const mixed = [
    { kind: 'message', id: 'x1', role: 'user', content: 'get to work', createdAt: 1 },
    { kind: 'tool-call', id: 't1', toolName: 'shell', authorId: A, args: { command: 'alice' }, status: 'completed', content: 'alice output', createdAt: 2 },
    { kind: 'tool-call', id: 't2', toolName: 'shell', authorId: B, args: { command: 'bob' }, status: 'completed', content: 'bob output', createdAt: 3 },
  ];

  const asA = rebuildHistory(mixed, { selfId: A, nameFor, inline: true });
  const argsA = asA.flatMap((m) => m.toolCalls ?? []).map((c) => c.args.command);
  check('own tool call kept', argsA.includes('alice'), argsA.join(','));
  check("colleague's tool call dropped", !argsA.includes('bob'), argsA.join(','));
  check(
    "and its result went with it",
    !asA.some((m) => m.role === 'tool' && /bob output/.test(m.content)),
  );

  const asB = rebuildHistory(mixed, { selfId: B, nameFor, inline: true });
  const argsB = asB.flatMap((m) => m.toolCalls ?? []).map((c) => c.args.command);
  check('the reverse holds for the other agent', argsB.includes('bob') && !argsB.includes('alice'), argsB.join(','));
}

console.log('\n[8] history written before authors existed still works');
{
  /*
   * Every tool entry recorded before this change has no author. Dropping
   * those would erase an agent's entire memory of its own past work, so an
   * absent author means "mine" -- the same rule messages already use.
   */
  const legacy = [
    { kind: 'tool-call', id: 't9', toolName: 'shell', args: { command: 'from before' }, status: 'completed', content: 'old output', createdAt: 1 },
  ];
  const built = rebuildHistory(legacy, { selfId: A, nameFor, inline: true });
  const args = built.flatMap((m) => m.toolCalls ?? []).map((c) => c.args.command);
  check('kept, not dropped', args.includes('from before'), args.join(','));
}

console.log('\n[9] a solo conversation is untouched');
{
  const mixed = [
    { kind: 'tool-call', id: 't1', toolName: 'shell', authorId: A, args: { command: 'alice' }, status: 'completed', content: 'a', createdAt: 1 },
    { kind: 'tool-call', id: 't2', toolName: 'shell', authorId: B, args: { command: 'bob' }, status: 'completed', content: 'b', createdAt: 2 },
  ];
  const solo = rebuildHistory(mixed);
  const args = solo.flatMap((m) => m.toolCalls ?? []).map((c) => c.args.command);
  check('nothing is filtered without a reader', args.length === 2, args.join(','));
}

console.log('\n[10] the structured name field is set, where a provider can use it');
{
  /*
   * OpenAI-compatible APIs have a `name` field on a message and AutoGen uses
   * exactly that -- `message["name"] = speaker.name` -- which is structured
   * and impossible for a model to mistake for its own prose. Anthropic has no
   * such field, so the inline prefix stays as the fallback. Both are set.
   */
  const asA = rebuildHistory(entries, { selfId: A, nameFor, inline: true });
  const theirs = asA.find((m) => m.content.includes('you own the parser'));
  const mine = asA.find((m) => m.content.includes('I will take the parser'));

  check("a colleague's message carries their name", theirs?.name === 'bob', JSON.stringify(theirs));
  check('and my own carries mine', mine?.name === 'alice', JSON.stringify(mine));
  check('the user gets no name', asA.find((m) => m.role === 'user')?.name === undefined);
}

console.log('\n[11] a label the model echoed back is not stored');
{
  /*
   * THE bug this whole area kept producing. A model reads a transcript full
   * of "[@claude] ..." prefixes, concludes they are part of the format, and
   * writes one itself. Storing that echo meant an agent's own message came
   * back next turn opening with a colleague's handle -- so it read its own
   * words as somebody else's, described itself in the third person, and
   * waited for a reply from an agent that had never spoken.
   *
   * Attribution is added on the way OUT, per reader. Never on the way in.
   */
  check(
    'a leading label is removed',
    stripSpeakerLabel('[@claude] That is my assignment echoed back') ===
      'That is my assignment echoed back',
    stripSpeakerLabel('[@claude] That is my assignment echoed back'),
  );
  check('with any handle', stripSpeakerLabel('[@local-gpt] on it') === 'on it');
  check('and leading whitespace', stripSpeakerLabel('  [@bob]   hello') === 'hello');

  /*
   * Narrow on purpose. Only a leading label, only one, and never text that
   * merely mentions a handle -- an agent quoting a colleague keeps its words.
   */
  check('ordinary text is untouched', stripSpeakerLabel('no label here') === 'no label here');
  check(
    'a mention mid-sentence survives',
    stripSpeakerLabel('I told [@claude] it was done') === 'I told [@claude] it was done',
  );
  check(
    'only one label is taken',
    stripSpeakerLabel('[@a] [@b] text') === '[@b] text',
    stripSpeakerLabel('[@a] [@b] text'),
  );
  check('a bare mention is not a label', stripSpeakerLabel('@claude look') === '@claude look');
}

console.log('\n[12] the sanitiser is actually WIRED, not merely exported');
{
  /*
   * The fault this repo repeats, and the reason this assertion is ugly.
   *
   * Testing `stripSpeakerLabel` in isolation passes whether or not anything
   * calls it -- verified: removing the call from the engine leaves every
   * other assertion in this file green. That is precisely how `name`,
   * `via`, `authorId` and the system prompt each ended up declared and
   * never used, every one of them shipping a real bug.
   *
   * So the assertion is structural: the engine must call it where an
   * assistant segment is written. Reading source is crude, and it is the
   * only thing that fails when somebody deletes the call.
   */
  // `root` is hoisted above; kept here for readability of this case.
  const engine = fs.readFileSync(path.join(root, 'packages/runtime/src/engine.ts'), 'utf8');

  check(
    'engine.ts strips labels when storing a segment',
    /content:\s*stripSpeakerLabel\(/.test(engine),
    'flush() stores raw model text, so an echoed [@handle] becomes permanent',
  );

  const branching = fs.readFileSync(path.join(root, 'packages/runtime/src/branching.ts'), 'utf8');
  check(
    'rebuildHistory sets the name field',
    /name:\s*authored/.test(branching),
    'attribution is inline-only, so providers with a name field cannot use it',
  );

  const adapter = fs.readFileSync(path.join(root, 'packages/llm/src/openai-compatible.ts'), 'utf8');
  check(
    'the OpenAI adapter sends it',
    /name:\s*named/.test(adapter),
    'ChatMessage.name is set but never reaches the provider',
  );
}

console.log('\n[13] one attribution channel, never two');
{
  /*
   * The prefix exists ONLY because Anthropic's Messages API has no `name`
   * field. Sending both to a provider that has one gives the model two
   * competing signals about who is speaking -- one of them inside text it
   * also writes itself.
   *
   * That is not hypothetical. It taught Local GPT that "[@claude] " was part
   * of the format; it emitted one, we stored it, and it then read its own
   * message as mine, narrated itself in the third person, and waited for a
   * reply from an agent that had never spoken.
   */
  const one = [
    { kind: 'message', id: 'z1', role: 'assistant', authorId: B, content: 'take the parser', createdAt: 1 },
  ];

  const structured = rebuildHistory(one, { selfId: A, nameFor, inline: false })[0];
  check('a name-capable provider gets the field', structured.name === 'bob', JSON.stringify(structured));
  check(
    'and clean text',
    structured.content === 'take the parser',
    JSON.stringify(structured.content),
  );

  const inline = rebuildHistory(one, { selfId: A, nameFor, inline: true })[0];
  check('a provider without one gets the prefix', inline.content === '[@bob] take the parser', inline.content);

  /*
   * The engine picks per provider. Reading source because the choice is a
   * boolean threaded through a call -- there is no behaviour to observe from
   * here, and this is exactly the wiring that keeps rotting.
   */
  const engine = fs.readFileSync(path.join(root, 'packages/runtime/src/engine.ts'), 'utf8');
  check(
    'the engine chooses inline only for Anthropic',
    /inlineSpeaker\s*=\s*\n?\s*cfg\.presetId === 'claude-subscription' \|\| cfg\.presetId === 'anthropic'/.test(engine),
    'inline is not selected per provider',
  );
  check('and passes it to rebuildHistory', /inline:\s*inlineSpeaker/.test(engine));
}

console.log('');
if (failures) {
  console.error(`SPEAKER-LABELS TEST FAILED — ${failures} assertion(s)\n`);
  process.exit(1);
}
console.log('SPEAKER-LABELS TEST PASSED\n');
