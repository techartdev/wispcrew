// Check the live repaired log: the first N records must match the repaired
// baseline exactly, and any extra tail records are new post-repair activity.
//
// usage: node check-live.mjs <backup-original.zstd> <live.zstd> <dsh-node_modules>
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [original, live, nodeModules] = process.argv.slice(2);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
const after = decodeAll(live).split('\n').filter((l) => l.trim() !== '');

console.log(`original=${before.length} live=${after.length} (new tail records: ${after.length - before.length})`);
if (after.length < before.length) {
	console.error('FAIL: live log LOST records');
	process.exit(1);
}

// The overlapping prefix must differ only by the ignorable marker.
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
console.log(`prefix differing=${differing} illegal=${illegal}`);

console.log('--- new tail records ---');
for (const line of after.slice(before.length)) {
	const e = JSON.parse(line);
	console.log(`  ${e.type} seq=${e.seq}`);
}

// Harness guards over the whole live log.
const S = await import(pathToFileURL(join(nodeModules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href);
const { KNOWN_SESSION_EVENT_TYPES, snapshotSessionEvent } = S;
const NON_EVENT = new Set(['session', 'text-chunks', 'tool-call-chunks']);

let events = 0;
const unsupported = [];
for (const line of after) {
	const e = JSON.parse(line);
	if (e.seq === undefined || e.type === undefined) continue;
	if (NON_EVENT.has(e.type)) continue;
	events++;
	if (!KNOWN_SESSION_EVENT_TYPES.has(e.type) && e.ignorable !== true) unsupported.push(`${e.type}@${e.seq}`);
	snapshotSessionEvent(e);
}
console.log(`live events=${events} unsupported=${unsupported.length} ${unsupported.slice(0, 5).join(',')}`);

const ok = illegal === 0 && unsupported.length === 0;
console.log(ok ? 'LIVE CHECK: PASS' : 'LIVE CHECK: FAIL');
process.exit(ok ? 0 : 1);
