/**
 * branching-test.ts — guards conversation rewind and forking.
 *
 * The risky part of branching is not the UI, it is turning a *display*
 * transcript back into a *model* history. Chat APIs reject a conversation
 * where an assistant tool call has no matching tool result, and the error
 * they return does not name the offending message. Cutting a transcript
 * mid-turn is therefore very easy to get subtly wrong, and the symptom is an
 * opaque HTTP 400 on the user's next message.
 *
 * Run: npm run test:branching --workspace @ghostbot/examples-cli
 */
import {
  prefixBefore,
  prefixThrough,
  rebuildHistory,
} from '../../../apps/desktop/src/main/branching.js';
import type { ChatMessage, TranscriptEntry } from '@ghostbot/shared';

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

let seq = 0;
const t = (): number => ++seq;

const userMsg = (id: string, content: string): TranscriptEntry => ({
  kind: 'message',
  id,
  role: 'user',
  content,
  createdAt: t(),
});

const asstMsg = (id: string, content: string, streaming = false): TranscriptEntry => ({
  kind: 'message',
  id,
  role: 'assistant',
  content,
  isStreaming: streaming,
  createdAt: t(),
});

const toolCard = (
  id: string,
  toolName: string,
  status: 'running' | 'completed' | 'failed' | 'denied',
  content?: string,
): TranscriptEntry => ({
  kind: 'tool-call',
  id,
  toolName,
  args: { path: '.' },
  status,
  ...(content === undefined ? {} : { content }),
  createdAt: t(),
});

const notice = (id: string): TranscriptEntry => ({
  kind: 'notice',
  id,
  level: 'info',
  text: 'Run interrupted.',
  createdAt: t(),
});

const approval = (id: string): TranscriptEntry => ({
  kind: 'approval',
  id,
  requestId: id,
  toolName: 'shell',
  summary: 'Run: ls',
  status: 'approved',
  createdAt: t(),
});

/** Every assistant tool call must have a matching tool result. */
function toolCallsAreAnswered(history: ChatMessage[]): boolean {
  const answered = new Set(
    history.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
  );
  return history
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .every((m) => m.toolCalls!.every((tc) => answered.has(tc.id)));
}

function main(): void {
  console.log('\n[rebuild] display-only entries never reach the model');
  {
    const history = rebuildHistory([
      userMsg('u1', 'hello'),
      notice('n1'),
      approval('a1'),
      asstMsg('a2', 'hi there'),
    ]);
    eq('two model messages', history.length, 2);
    eq('first is the user', history[0]?.role, 'user');
    eq('second is the assistant', history[1]?.role, 'assistant');
    check('no notice text leaked', !JSON.stringify(history).includes('interrupted'));
    check('no approval text leaked', !JSON.stringify(history).includes('Run: ls'));
  }

  console.log('\n[rebuild] tool cards become paired call + result');
  {
    const history = rebuildHistory([
      userMsg('u1', 'list files'),
      toolCard('tc1', 'list_dir', 'completed', 'a.txt\nb.txt'),
      asstMsg('a1', 'There are two files.'),
    ]);
    check('every tool call is answered', toolCallsAreAnswered(history));
    const call = history.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    check('assistant carries the call', Boolean(call));
    eq('call id preserved', call?.toolCalls?.[0]?.id, 'tc1');
    eq('tool name preserved', call?.toolCalls?.[0]?.name, 'list_dir');
    const result = history.find((m) => m.role === 'tool');
    eq('result references the call', result?.toolCallId, 'tc1');
    check('result carries the output', (result?.content ?? '').includes('a.txt'));
  }

  console.log('\n[rebuild] incomplete tool states still produce a valid pair');
  {
    // This is the case that breaks providers: cutting while a tool is still
    // running, or after the user denied it, must not leave a dangling call.
    for (const status of ['running', 'denied', 'failed'] as const) {
      const history = rebuildHistory([userMsg('u1', 'go'), toolCard('tc1', 'shell', status)]);
      check(`${status}: call is answered`, toolCallsAreAnswered(history));
      const result = history.find((m) => m.role === 'tool');
      check(`${status}: result is non-empty`, (result?.content ?? '').length > 0);
    }
  }

  console.log('\n[rebuild] partial output is discarded');
  {
    // Half a streamed sentence is worse context than none.
    const history = rebuildHistory([userMsg('u1', 'hi'), asstMsg('a1', 'I was thi', true)]);
    eq('streaming assistant dropped', history.length, 1);
    eq('only the user survives', history[0]?.role, 'user');

    const empty = rebuildHistory([userMsg('u1', 'hi'), asstMsg('a2', '   ')]);
    eq('whitespace-only assistant dropped', empty.length, 1);
  }

  console.log('\n[rebuild] every prefix of a real conversation is valid');
  {
    // The strongest guarantee: cut anywhere, the result is still something a
    // provider will accept.
    const full: TranscriptEntry[] = [
      userMsg('u1', 'find the config'),
      toolCard('tc1', 'grep', 'completed', 'found in a.json'),
      asstMsg('a1', 'It is in a.json.'),
      userMsg('u2', 'read it'),
      approval('ap1'),
      toolCard('tc2', 'read_file', 'completed', '{"k":1}'),
      notice('n1'),
      asstMsg('a2', 'It contains one key.'),
      userMsg('u3', 'and now?'),
      toolCard('tc3', 'shell', 'running'),
    ];
    let bad = 0;
    for (let i = 0; i <= full.length; i++) {
      const h = rebuildHistory(full.slice(0, i));
      if (!toolCallsAreAnswered(h)) {
        bad++;
        console.error(`    prefix length ${i} left an unanswered tool call`);
      }
    }
    eq('all prefixes provider-valid', bad, 0);
  }

  console.log('\n[prefix] cut points');
  {
    const entries = [userMsg('u1', 'a'), asstMsg('a1', 'b'), userMsg('u2', 'c')];

    const through = prefixThrough(entries, 'a1');
    eq('through: length', through?.length, 2);
    eq('through: ends with the named entry', through?.[1]?.id, 'a1');

    const before = prefixBefore(entries, 'a1');
    eq('before: length', before?.length, 1);
    eq('before: excludes the named entry', before?.[0]?.id, 'u1');

    // "Edit and retry" on the first message leaves an empty conversation.
    eq('before the first entry is empty', prefixBefore(entries, 'u1')?.length, 0);
    eq('through the last entry keeps everything', prefixThrough(entries, 'u2')?.length, 3);

    // A vanished entry is not an error — the UI may race a cleared chat.
    eq('missing id yields null (through)', prefixThrough(entries, 'nope'), null);
    eq('missing id yields null (before)', prefixBefore(entries, 'nope'), null);
    eq('empty transcript yields null', prefixThrough([], 'u1'), null);
  }

  console.log('\n[rebuild] edge cases do not throw');
  {
    eq('empty transcript', rebuildHistory([]).length, 0);
    eq('only notices', rebuildHistory([notice('n1'), notice('n2')]).length, 0);
    // A conversation that is nothing but an unfinished tool call still has to
    // come back as a valid pair rather than a dangling assistant message.
    check('lone running tool card', toolCallsAreAnswered(rebuildHistory([toolCard('tc1', 'shell', 'running')])));
  }

  console.log('');
  if (failures > 0) {
    console.error(`BRANCHING TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('BRANCHING TEST PASSED\n');
}

main();
