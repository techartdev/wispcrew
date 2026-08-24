/**
 * attachments.ts — turn files on disk into model-ready `Attachment` records.
 *
 * Three classes of file, three treatments:
 *
 *  - **Images** become base64 and are sent as vision content, when the
 *    provider supports it. Providers that do not are told the image exists
 *    rather than being handed a megabyte of base64 they will reject.
 *  - **Text-like files** (source code, JSON, CSV, Markdown, …) are decoded
 *    and inlined into the prompt.
 *  - **Everything else** is described by name, type, and size only. Feeding a
 *    model the bytes of a .docx or .zip wastes context and produces nothing.
 *
 * Every limit here exists because the alternative is a failed request or a
 * surprising bill: a 20 MB image is ~27 MB of base64, which most providers
 * reject outright and all of them charge for.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '@ghostbot/shared';

/** Largest image we will base64 and send. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Largest text file we will inline whole. */
export const MAX_TEXT_BYTES = 512 * 1024;
/** How much of an over-long text file to keep. */
const TEXT_HEAD_BYTES = 128 * 1024;
/** Cap on attachments per message. */
export const MAX_ATTACHMENTS = 10;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * Extensions we treat as text.
 *
 * An allow-list rather than a sniff: misclassifying a binary as text floods
 * the context with mojibake, which is worse than declining to read it.
 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.m', '.mm',
  '.php', '.pl', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.diff', '.patch',
  '.gitignore', '.dockerignore', '.editorconfig',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best-effort MIME type from the extension. */
function mimeFor(ext: string): string {
  return IMAGE_TYPES[ext] ?? MIME_BY_EXT[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

/**
 * Read one file into an `Attachment`.
 *
 * Never throws for content reasons: an unreadable or oversized file comes
 * back as a `binary` attachment whose name explains the problem, so one bad
 * file cannot fail the whole message.
 */
export async function loadAttachment(filePath: string): Promise<Attachment> {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeFor(ext);

  let size = 0;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { name, mimeType, size: 0, kind: 'binary', path: filePath };
    }
    size = stat.size;
  } catch (err) {
    return {
      name: `${name} (unreadable: ${(err as Error).message})`,
      mimeType,
      size: 0,
      kind: 'binary',
      path: filePath,
    };
  }

  if (IMAGE_TYPES[ext]) {
    if (size > MAX_IMAGE_BYTES) {
      return {
        name: `${name} (image too large: ${humanSize(size)}, limit ${humanSize(MAX_IMAGE_BYTES)})`,
        mimeType,
        size,
        kind: 'binary',
        path: filePath,
      };
    }
    try {
      const buf = await fs.readFile(filePath);
      return { name, mimeType, size, kind: 'image', data: buf.toString('base64'), path: filePath };
    } catch (err) {
      return { name: `${name} (read failed: ${(err as Error).message})`, mimeType, size, kind: 'binary', path: filePath };
    }
  }

  if (TEXT_EXTENSIONS.has(ext) || (ext === '' && size <= MAX_TEXT_BYTES)) {
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const readBytes = Math.min(size, size > MAX_TEXT_BYTES ? TEXT_HEAD_BYTES : MAX_TEXT_BYTES);
        const buf = Buffer.alloc(readBytes);
        const { bytesRead } = await handle.read(buf, 0, readBytes, 0);
        let text = buf.subarray(0, bytesRead).toString('utf8');

        // A NUL byte means this is not really text; fall back to describing it
        // rather than pasting binary garbage into the prompt.
        if (text.includes('\u0000')) {
          return { name, mimeType: 'application/octet-stream', size, kind: 'binary', path: filePath };
        }
        if (size > readBytes) {
          text += `\n\n…[truncated: showing ${humanSize(readBytes)} of ${humanSize(size)}]`;
        }
        return { name, mimeType, size, kind: 'text', data: text, path: filePath };
      } finally {
        await handle.close();
      }
    } catch (err) {
      return { name: `${name} (read failed: ${(err as Error).message})`, mimeType, size, kind: 'binary', path: filePath };
    }
  }

  return { name, mimeType, size, kind: 'binary', path: filePath };
}

/** Load several files, capped, skipping nothing silently. */
export async function loadAttachments(paths: string[]): Promise<Attachment[]> {
  const limited = paths.slice(0, MAX_ATTACHMENTS);
  return Promise.all(limited.map(loadAttachment));
}

/**
 * Render non-image attachments as text to prepend to the user's prompt.
 *
 * Images are excluded: they travel as structured vision content instead.
 * Returns an empty string when there is nothing to add.
 */
export function attachmentsToPromptText(attachments: Attachment[]): string {
  const parts: string[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') continue;
    if (a.kind === 'text' && a.data !== undefined) {
      // A fence keeps file content from being read as instructions, and the
      // header tells the model what it is looking at.
      parts.push(`--- Attached file: ${a.name} (${a.mimeType}, ${humanSize(a.size)}) ---\n${a.data}`);
    } else {
      parts.push(
        `--- Attached file: ${a.name} (${a.mimeType}, ${humanSize(a.size)}) — ` +
          `binary content not included; use the file tools to inspect it if needed. ---`,
      );
    }
  }
  return parts.join('\n\n');
}
