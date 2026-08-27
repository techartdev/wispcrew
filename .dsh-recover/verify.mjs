// Verify a repaired DSH session log against the harness's OWN guards, and
// prove the repair changed nothing except the `ignorable` marker.
//
// usage: node verify.mjs <original.zstd> <patched.zstd> <dsh-node_modules>
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [original, patched, nodeModules] = process.argv.slice(2);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode every frame of a concatenated zstd stream to one text blob. */
function decodeAll(file) {
	const buf = readFileSync(file);
	const parts = [];
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
		parts.push(zstdDecompressSync(buf.subarray(off, next)));
		off = next;
	}
	return Buffer.concat(parts).toString('utf8');
}

const before = decodeAll(original).split('\n').filter((l) => l.trim() !== '');
const after = decodeAll(patched).split('\n').filter((l) => l.trim() !== '');

console.log(`record count  before=${before.length} after=${after.length}`);
if (before.length !== after.length) {
	console.error('FAIL: record count changed');
	process.exit(1);
}

// Every record must be identical except for an added `ignorable: true`.
let differing = 0;
let illegal = 0;
for (let i = 0; i < before.length; i++) {
	if (before[i] === after[i]) continue;
	differing++;
	const a = JSON.parse(before[i]);
	const b = JSON.parse(after[i]);
	if (b.ignorable !== true) { illegal++; continue; }
	delete b.ignorable;
	if (JSON.stringify(a) !== JSON.stringify(b)) illegal++;
}
console.log(`records differing: ${differing} | illegal differences: ${illegal}`);
if (illegal > 0) {
	console.error('FAIL: a change other than the ignorable marker was made');
	process.exit(1);
}

// Now run the harness's real validators over the patched log.
const sessionLib = join(nodeModules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
const S = await import(pathToFileURL(sessionLib).href);
const { KNOWN_SESSION_EVENT_TYPES, snapshotSessionEvent } = S;

// Non-event bookkeeping lines the reader does not treat as session events.
const NON_EVENT = new Set(['session', 'text-chunks', 'tool-call-chunks']);

let events = 0;
let snapshotted = 0;
let lastSeq = -1;
let seqRegressions = 0;
const unsupported = [];

for (const line of after) {
	const event = JSON.parse(line);
	if (event.seq === undefined || event.type === undefined) continue;
	if (NON_EVENT.has(event.type)) continue;
	events++;
	if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
		unsupported.push(`${event.type}@${event.seq}`);
	}
	snapshotSessionEvent(event); // throws on a malformed envelope/message
	snapshotted++;
	if (typeof event.seq === 'number') {
		if (event.seq < lastSeq) seqRegressions++;
		lastSeq = event.seq;
	}
}

console.log(`events=${events} snapshotted=${snapshotted} maxSeq=${lastSeq}`);
console.log(`unsupported=${unsupported.length} ${unsupported.slice(0, 5).join(',')}`);
console.log(`seqRegressions=${seqRegressions}`);

// Conversation content must be fully intact.
const counts = {};
for (const line of after) {
	const event = JSON.parse(line);
	if (event?.type) counts[event.type] = (counts[event.type] ?? 0) + 1;
}
for (const t of ['user/message', 'assistant/message', 'tool/call', 'tool/result']) {
	console.log(`  ${t}: ${counts[t] ?? 0}`);
}

const ok = unsupported.length === 0 && illegal === 0 && seqRegressions === 0;
console.log(ok ? 'VERIFY: PASS' : 'VERIFY: FAIL');
process.exit(ok ? 0 : 1);
