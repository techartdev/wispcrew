/**
 * attachment-test.ts — offline guards for file attachments.
 *
 * Covers the two things most likely to break silently:
 *  1. **Classification** — a binary misread as text floods the model context
 *     with mojibake; an oversized image gets rejected by the API with an
 *     unhelpful error.
 *  2. **Wire format** — images must become provider-specific structured
 *     content (OpenAI `image_url` parts, Anthropic `image` blocks), not a
 *     base64 blob pasted into the text.
 *
 * Uses a fake fetch so it runs offline and asserts the exact JSON we send.
 *
 * Run: npm run test:attachments --workspace @ghostbot/examples-cli
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  loadAttachment,
  loadAttachments,
  attachmentsToPromptText,
  MAX_ATTACHMENTS,
} from '@ghostbot/runtime';
import { configFromPreset, createProvider } from '@ghostbot/llm';
import type { Attachment } from '@ghostbot/shared';

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

/** Minimal valid PNG, written by hand so the test needs no image library. */
function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 220;
      raw[o + 1] = 40;
      raw[o + 2] = 40;
    }
  }
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-att-test-'));

async function main(): Promise<void> {
  console.log('\n[classify] file kinds');
  {
    const md = path.join(dir, 'notes.md');
    fs.writeFileSync(md, '# Title\nbody text\n');
    const a = await loadAttachment(md);
    eq('markdown is text', a.kind, 'text');
    eq('markdown mime', a.mimeType, 'text/markdown');
    check('markdown content decoded', (a.data ?? '').includes('body text'));

    const png = path.join(dir, 'img.png');
    fs.writeFileSync(png, makePng(4, 4));
    const i = await loadAttachment(png);
    eq('png is image', i.kind, 'image');
    eq('png mime', i.mimeType, 'image/png');
    check('png base64 present', (i.data ?? '').length > 0);
    check('base64 is not the raw bytes', !(i.data ?? '').includes('PNG'));

    const bin = path.join(dir, 'blob.zip');
    fs.writeFileSync(bin, Buffer.alloc(512, 7));
    const b = await loadAttachment(bin);
    eq('zip is binary', b.kind, 'binary');
    check('binary carries no data', b.data === undefined);

    // A .txt full of NUL bytes is not really text; inlining it would flood
    // the prompt with control characters.
    const fake = path.join(dir, 'fake.txt');
    fs.writeFileSync(fake, Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
    const f = await loadAttachment(fake);
    eq('NUL-containing .txt falls back to binary', f.kind, 'binary');

    const missing = await loadAttachment(path.join(dir, 'nope.txt'));
    eq('missing file degrades to binary', missing.kind, 'binary');
    check('missing file explains itself', missing.name.includes('unreadable'));
  }

  console.log('\n[limits] oversized inputs degrade safely');
  {
    // 600 KB of text exceeds the inline cap; it should be truncated, not dropped.
    const big = path.join(dir, 'big.log');
    fs.writeFileSync(big, 'x'.repeat(600 * 1024));
    const a = await loadAttachment(big);
    eq('large text still classified as text', a.kind, 'text');
    check('large text truncated', (a.data ?? '').includes('truncated'));
    check('large text bounded', (a.data ?? '').length < 200 * 1024);

    const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => {
      const p = path.join(dir, `f${i}.txt`);
      fs.writeFileSync(p, `file ${i}`);
      return p;
    });
    const loaded = await loadAttachments(many);
    eq(`attachment count capped at ${MAX_ATTACHMENTS}`, loaded.length, MAX_ATTACHMENTS);
  }

  console.log('\n[prompt] non-image rendering');
  {
    const atts: Attachment[] = [
      { name: 'a.md', mimeType: 'text/markdown', size: 10, kind: 'text', data: 'hello world' },
      { name: 'b.png', mimeType: 'image/png', size: 20, kind: 'image', data: 'QUJD' },
      { name: 'c.zip', mimeType: 'application/zip', size: 30, kind: 'binary' },
    ];
    const text = attachmentsToPromptText(atts);
    check('text file inlined', text.includes('hello world'));
    check('text file labelled', text.includes('a.md'));
    check('binary described', text.includes('c.zip'));
    check('image excluded from prompt text', !text.includes('b.png'));
    check('image base64 never inlined', !text.includes('QUJD'));
    eq('empty input yields empty string', attachmentsToPromptText([]), '');
  }

  console.log('\n[wire] OpenAI vision content parts');
  {
    const body = await captureBody('openai', 'gpt-4o-mini');
    const userMsg = body.messages.find((m: Record<string, unknown>) => m.role === 'user');
    check('user content is an array', Array.isArray(userMsg?.content));
    const parts = (userMsg?.content ?? []) as Array<Record<string, unknown>>;
    check('has a text part', parts.some((p) => p.type === 'text'));
    const imgPart = parts.find((p) => p.type === 'image_url');
    check('has an image_url part', Boolean(imgPart));
    const url = (imgPart?.image_url as { url?: string } | undefined)?.url ?? '';
    check('image is a data URL', url.startsWith('data:image/png;base64,'));
    check('image carries the payload', url.endsWith('QUJD'));
  }

  console.log('\n[wire] messages without images stay plain strings');
  {
    const body = await captureBody('openai', 'gpt-4o-mini', []);
    const userMsg = body.messages.find((m: Record<string, unknown>) => m.role === 'user');
    // Compatibility matters: many OpenAI-compatible servers reject the
    // content-parts array, so we must not use it unless there is an image.
    eq('content is a plain string', typeof userMsg?.content, 'string');
  }

  console.log('\n[wire] Anthropic image blocks');
  {
    const body = await captureBody('anthropic', 'claude-sonnet-4-5');
    const userMsg = body.messages.find((m: Record<string, unknown>) => m.role === 'user');
    const blocks = (userMsg?.content ?? []) as Array<Record<string, unknown>>;
    check('content is a block array', Array.isArray(blocks));
    const img = blocks.find((b) => b.type === 'image');
    check('has an image block', Boolean(img));
    const source = img?.source as { type?: string; media_type?: string; data?: string } | undefined;
    eq('source type is base64', source?.type, 'base64');
    eq('media type preserved', source?.media_type, 'image/png');
    eq('payload preserved', source?.data, 'QUJD');
    check('text block present', blocks.some((b) => b.type === 'text'));
  }

  console.log('\n[routing] the right adapter for each endpoint');
  {
    // OpenAI reasoning models must use /v1/responses: chat-completions
    // refuses function tools for them unless reasoning is disabled, and
    // disabling reasoning measurably degrades answers. Everyone else must
    // keep chat-completions — no other vendor implements /v1/responses.
    const cases: Array<[string, string, string]> = [
      ['openai', 'gpt-5.6-luna', 'OpenAIResponsesProvider'],
      ['openai', 'gpt-5.4-mini', 'OpenAIResponsesProvider'],
      ['openai', 'gpt-4o-mini', 'OpenAICompatibleProvider'],
      ['deepseek', 'deepseek-chat', 'OpenAICompatibleProvider'],
      // A local server borrowing an OpenAI model name must NOT be rerouted.
      ['ollama', 'gpt-5.6-luna', 'OpenAICompatibleProvider'],
      ['groq', 'llama-3.3-70b-versatile', 'OpenAICompatibleProvider'],
      ['openrouter', 'openai/gpt-5.5', 'OpenAICompatibleProvider'],
      ['anthropic', 'claude-sonnet-4-5', 'AnthropicProvider'],
    ];
    for (const [preset, model, expected] of cases) {
      const actual = createProvider(configFromPreset(preset, { apiKey: 'x', model })).constructor
        .name;
      eq(`${preset}/${model}`, actual, expected);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`ATTACHMENT TEST FAILED — ${failures} assertion(s)\n`);
    process.exit(1);
  }
  console.log('ATTACHMENT TEST PASSED\n');
}

/**
 * Run one provider request against a stubbed `fetch` and return the parsed
 * request body, so we can assert the exact wire shape without a network call.
 */
async function captureBody(
  presetId: string,
  model: string,
  attachments?: Attachment[],
): Promise<Record<string, never> & { messages: Array<Record<string, unknown>> }> {
  const atts: Attachment[] =
    attachments ??
    [{ name: 'b.png', mimeType: 'image/png', size: 3, kind: 'image', data: 'QUJD' }];

  const realFetch = globalThis.fetch;
  let captured: unknown = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    // Minimal non-streaming success body for each provider shape.
    const payload =
      presetId === 'anthropic'
        ? { content: [{ type: 'text', text: 'ok' }], usage: {} }
        : { choices: [{ message: { content: 'ok' } }], usage: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = createProvider(configFromPreset(presetId, { apiKey: 'test-key', model }));
    for await (const _ of provider.chat({
      messages: [{ role: 'user', content: 'describe this', attachments: atts }],
      stream: false,
    })) {
      /* drain */
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured as Record<string, never> & { messages: Array<Record<string, unknown>> };
}

main()
  .catch((err) => {
    console.error('ATTACHMENT TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
