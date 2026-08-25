/**
 * store.ts — durable JSON storage for agents, transcripts, routines, skills.
 *
 * Deliberately dependency-free: one small JSON file per collection under
 * `<userData>`, written atomically. At GhostBot's scale (tens of agents,
 * thousands of transcript entries) this is faster than it sounds and keeps
 * the data trivially inspectable and backup-friendly — a user can read,
 * diff, or hand-edit their own data, which matters for an open-source tool.
 *
 * Two hard-won conventions carried over from the previous implementation:
 *  - **Readers are BOM-tolerant.** PowerShell writes UTF-8 BOMs; a bare
 *    `JSON.parse` on such a file throws on the first character.
 *  - **Writes are atomic** (temp file + rename). A crash mid-write would
 *    otherwise truncate a user's entire agent roster.
 *
 * ## Concurrency: one writer per profile
 *
 * Atomic writes prevent a *torn* file. They do nothing about a **lost
 * update**, and the difference matters now that a daemon exists.
 *
 * Measured, not assumed: two writers that each load a collection, append to
 * their own copy, and save it back end with only the second writer's change
 * — the first is silently erased. In practice that would be a user's typed
 * message vanishing because a routine fired at the same instant.
 *
 * The read-modify-write helpers here (`upsertTranscriptEntry`,
 * `updateAgent`, and friends) re-read immediately before saving, so
 * interleaved calls are safe. What is **not** safe is holding a snapshot and
 * calling `saveTranscript`/`saveAgents` with it later.
 *
 * Consequently a profile has exactly one engine writing to it. The desktop
 * app runs its own engine; `ghostbot serve` is for machines where it is the
 * only writer. Pointing both at one profile is a supported *sequence* (start
 * one, stop it, start the other) but never a supported *overlap*.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentRecord,
  RoutineRecord,
  SkillRecord,
  TranscriptEntry,
} from '@ghostbot/shared';
import { fileLog } from './filelog.js';
import { writeCheckpoint } from './checkpoints.js';

let baseDir = '';

/** Point the store at `<userData>`; call once during app startup. */
export function initStore(userDataDir: string): void {
  baseDir = userDataDir;
  fs.mkdirSync(transcriptDir(), { recursive: true });
}

function filePath(name: string): string {
  return path.join(baseDir, name);
}

function transcriptDir(): string {
  return path.join(baseDir, 'transcripts');
}

/** Parse JSON tolerating a UTF-8 BOM; returns `fallback` on any failure. */
/**
 * Read a JSON file, tolerating a BOM and returning a fallback on any failure.
 *
 * Exported so other modules storing small JSON documents reuse the same
 * BOM tolerance and the same atomic write below, rather than each
 * reimplementing them and each getting one of the two wrong.
 */
export function readJson<T>(file: string, fallback: T): T {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read a file that must contain an array, repairing what can be repaired.
 *
 * These files are plain JSON precisely so users can inspect and hand-edit
 * them, which means malformed input is a normal condition, not an
 * exceptional one. A single object (PowerShell's `ConvertTo-Json` silently
 * unwraps one-element arrays, for instance) is promoted to a one-element
 * array; anything else falls back to empty.
 *
 * This exists because a bare object here previously reached the renderer and
 * crashed it with "find is not a function" — a blank window with no
 * explanation. Bad data in a user-editable file must degrade, never brick
 * the app.
 */
function readArray<T>(file: string): T[] {
  const parsed = readJson<unknown>(file, []);
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === 'object') {
    fileLog('[store] repaired non-array in', path.basename(file));
    return [parsed as T];
  }
  return [];
}

/**
 * Write JSON atomically. Writing to a temp file and renaming means a reader
 * (or a crash) never observes a half-written file: rename is atomic on both
 * NTFS and POSIX filesystems.
 */
/** Write JSON atomically (temp file + rename). See the note above. */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function now(): number {
  return Date.now();
}

/** Short, collision-resistant id. Not a UUID — these are local-only keys. */
export function newId(prefix: string): string {
  return `${prefix}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

const AGENTS_FILE = 'agents.json';

export function listAgents(): AgentRecord[] {
  return readArray<AgentRecord>(filePath(AGENTS_FILE));
}

function saveAgents(agents: AgentRecord[]): void {
  writeJson(filePath(AGENTS_FILE), agents);
}

export function getAgent(id: string): AgentRecord | undefined {
  return listAgents().find((a) => a.id === id);
}

export function createAgent(patch: Partial<AgentRecord>): AgentRecord {
  const agents = listAgents();
  const ts = now();
  const record: AgentRecord = {
    id: patch.id ?? newId('agent'),
    name: patch.name?.trim() || `Agent ${agents.length + 1}`,
    description: patch.description,
    persona: patch.persona,
    avatarShape: patch.avatarShape,
    avatarColor: patch.avatarColor,
    presetId: patch.presetId,
    model: patch.model,
    workspaceRoot: patch.workspaceRoot,
    approvalPolicy: patch.approvalPolicy,
    disabledTools: patch.disabledTools,
    pinned: patch.pinned ?? false,
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  };
  saveAgents([...agents, record]);
  return record;
}

export function updateAgent(id: string, patch: Partial<AgentRecord>): AgentRecord {
  const agents = listAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`No such agent: ${id}`);
  // `id`/`createdAt` are identity, never patchable.
  const next: AgentRecord = {
    ...agents[idx]!,
    ...patch,
    id: agents[idx]!.id,
    createdAt: agents[idx]!.createdAt,
    updatedAt: now(),
  };
  agents[idx] = next;
  saveAgents(agents);
  return next;
}

export function deleteAgent(id: string): void {
  saveAgents(listAgents().filter((a) => a.id !== id));
  try {
    fs.rmSync(transcriptPath(id), { force: true });
  } catch {
    /* transcript may not exist */
  }
}

/**
 * Copy an agent's configuration under a new id.
 *
 * Conversation history is intentionally NOT copied: the duplicate is a fresh
 * teammate with the same setup, not a fork of a conversation. (Branching a
 * conversation is a separate feature with different semantics.)
 */
export function duplicateAgent(id: string): AgentRecord {
  const source = getAgent(id);
  if (!source) throw new Error(`No such agent: ${id}`);
  return createAgent({
    ...source,
    id: undefined,
    name: `${source.name} copy`,
    pinned: false,
  });
}

/* ------------------------------------------------------------------ */
/* Transcripts                                                         */
/* ------------------------------------------------------------------ */

/** Keep memory and disk bounded; older entries are dropped on append. */
const MAX_TRANSCRIPT_ENTRIES = 2000;

function transcriptPath(agentId: string): string {
  // Ids are generated by `newId` (alphanumeric + underscore), but this is a
  // filesystem path built from a value that also arrives over IPC — sanitize
  // so a crafted id can never escape the transcripts directory.
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(transcriptDir(), `${safe}.json`);
}

export function loadTranscript(agentId: string): TranscriptEntry[] {
  return readArray<TranscriptEntry>(transcriptPath(agentId));
}

export function saveTranscript(
  agentId: string,
  entries: TranscriptEntry[],
  reason = 'write',
): void {
  /*
   * Keep the old version when a write would lose content.
   *
   * A transcript is written whole, so anything that shortens one destroys
   * the difference permanently. That happened for real during development —
   * a careless cleanup erased a 33-entry conversation with nothing to
   * restore from.
   *
   * Only shrinking writes are checkpointed. Streaming rewrites the file on
   * every token, and a growing transcript has lost nothing: the previous
   * state is a prefix of the new one. Losing entries is the rare event worth
   * capturing, and it is cheap to detect.
   */
  try {
    const previous = loadTranscript(agentId);
    if (previous.length > entries.length) {
      writeCheckpoint(baseDir, agentId, previous, reason);
    }
  } catch {
    // A checkpoint is a safety net. Failing to take one must never block the
    // write the caller actually asked for.
  }

  writeJson(transcriptPath(agentId), entries.slice(-MAX_TRANSCRIPT_ENTRIES));
}

/**
 * Insert or replace an entry by id and persist.
 *
 * Upsert (rather than append) is what makes streaming cheap: the assistant
 * message keeps one stable id and is rewritten as tokens arrive, so the UI
 * updates in place instead of accumulating fragments.
 */
export function upsertTranscriptEntry(agentId: string, entry: TranscriptEntry): TranscriptEntry[] {
  const entries = loadTranscript(agentId);
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) entries.push(entry);
  else entries[idx] = entry;
  saveTranscript(agentId, entries);
  return entries;
}

export function clearTranscript(agentId: string): void {
  // Named, so the recovery list reads "before the chat was cleared" rather
  // than a generic "write". That label is the whole basis on which someone
  // picks which saved version they want back.
  saveTranscript(agentId, [], 'cleared');
}

/* ------------------------------------------------------------------ */
/* Routines                                                            */
/* ------------------------------------------------------------------ */

const ROUTINES_FILE = 'routines.json';
/** Bound stored run history so a busy routine cannot grow without limit. */
const MAX_RUNS_KEPT = 20;

export function listRoutines(agentId?: string): RoutineRecord[] {
  const all = readArray<RoutineRecord>(filePath(ROUTINES_FILE));
  return agentId ? all.filter((r) => r.agentId === agentId) : all;
}

function saveRoutines(routines: RoutineRecord[]): void {
  writeJson(filePath(ROUTINES_FILE), routines);
}

export function createRoutine(patch: Partial<RoutineRecord> & { agentId: string }): RoutineRecord {
  const ts = now();
  const record: RoutineRecord = {
    id: patch.id ?? newId('routine'),
    agentId: patch.agentId,
    name: patch.name?.trim() || 'Untitled routine',
    cron: patch.cron ?? '0 9 * * *',
    timezone: patch.timezone,
    prompt: patch.prompt ?? '',
    enabled: patch.enabled ?? false,
    runs: [],
    createdAt: ts,
    updatedAt: ts,
  };
  saveRoutines([...listRoutines(), record]);
  return record;
}

export function updateRoutine(id: string, patch: Partial<RoutineRecord>): RoutineRecord {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`No such routine: ${id}`);
  const next: RoutineRecord = {
    ...routines[idx]!,
    ...patch,
    id: routines[idx]!.id,
    createdAt: routines[idx]!.createdAt,
    updatedAt: now(),
  };
  routines[idx] = next;
  saveRoutines(routines);
  return next;
}

export function deleteRoutine(id: string): void {
  saveRoutines(listRoutines().filter((r) => r.id !== id));
}

/** Record a run outcome, trimming history to the most recent N. */
export function recordRoutineRun(
  id: string,
  run: RoutineRecord['runs'] extends Array<infer R> | undefined ? R : never,
): void {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const existing = routines[idx]!.runs ?? [];
  const merged = [run, ...existing.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS_KEPT);
  routines[idx] = { ...routines[idx]!, runs: merged, lastRunAt: run.startedAt, updatedAt: now() };
  saveRoutines(routines);
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

const SKILLS_FILE = 'skills.json';

export function listSkills(): SkillRecord[] {
  return readArray<SkillRecord>(filePath(SKILLS_FILE));
}

function saveSkills(skills: SkillRecord[]): void {
  writeJson(filePath(SKILLS_FILE), skills);
}

export function createSkill(patch: Partial<SkillRecord>): SkillRecord {
  const ts = now();
  const record: SkillRecord = {
    id: patch.id ?? newId('skill'),
    // The name is an invocation token (`/name`), so spaces would break parsing.
    name: (patch.name ?? 'skill').trim().replace(/\s+/g, '-'),
    description: patch.description,
    body: patch.body ?? '',
    agentIds: patch.agentIds,
    enabled: patch.enabled ?? true,
    createdAt: ts,
    updatedAt: ts,
  };
  saveSkills([...listSkills(), record]);
  return record;
}

export function updateSkill(id: string, patch: Partial<SkillRecord>): SkillRecord {
  const skills = listSkills();
  const idx = skills.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`No such skill: ${id}`);
  const next: SkillRecord = {
    ...skills[idx]!,
    ...patch,
    name: patch.name ? patch.name.trim().replace(/\s+/g, '-') : skills[idx]!.name,
    id: skills[idx]!.id,
    createdAt: skills[idx]!.createdAt,
    updatedAt: now(),
  };
  skills[idx] = next;
  saveSkills(skills);
  return next;
}

export function deleteSkill(id: string): void {
  saveSkills(listSkills().filter((s) => s.id !== id));
}
