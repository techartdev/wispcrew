// Repair a DSH session log by marking unknown plugin events `ignorable`.
//
// Preserves the original zstd frame layout: only frames that actually contain
// a target event are decompressed, edited and recompressed. Every other frame
// is copied through byte-for-byte.
//
// usage: node patch-frames.mjs <input.zstd> <output.zstd> <event-type>
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const [input, output, eventType = 'web/keyless-search'] = process.argv.slice(2);
if (!input || !output) {
	console.error('usage: node patch-frames.mjs <input.zstd> <output.zstd> [event-type]');
	process.exit(2);
}

const buf = readFileSync(input);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Split the concatenated stream into its original frame boundaries. */
const bounds = [];
let off = 0;
while (off < buf.length) {
	if (buf.compare(MAGIC, 0, 4, off, Math.min(off + 4, buf.length)) !== 0) {
		const next = buf.indexOf(MAGIC, off + 1);
		if (next < 0) break;
		off = next;
		continue;
	}
	let next = buf.indexOf(MAGIC, off + 4);
	if (next < 0) next = buf.length;
	bounds.push([off, next]);
	off = next;
}

const needle = JSON.stringify(eventType); // `"web/keyless-search"`
const outFrames = [];
let framesRewritten = 0;
let eventsPatched = 0;

for (const [start, end] of bounds) {
	const raw = buf.subarray(start, end);
	let text;
	try {
		text = zstdDecompressSync(raw).toString('utf8');
	} catch {
		outFrames.push(raw); // undecodable frame: pass through untouched
		continue;
	}

	if (!text.includes(needle)) {
		outFrames.push(raw);
		continue;
	}

	let touched = false;
	const lines = text.split('\n').map((line) => {
		if (line.trim() === '') return line;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return line; // not JSON: leave exactly as-is
		}
		if (event?.type === eventType && event.ignorable !== true) {
			event.ignorable = true;
			touched = true;
			eventsPatched++;
			return JSON.stringify(event);
		}
		return line;
	});

	if (!touched) {
		outFrames.push(raw);
		continue;
	}

	outFrames.push(zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8')));
	framesRewritten++;
}

writeFileSync(output, Buffer.concat(outFrames));
console.log(
	`frames total ${bounds.length} | rewritten ${framesRewritten} | passthrough ${bounds.length - framesRewritten} | events patched ${eventsPatched}`,
);
