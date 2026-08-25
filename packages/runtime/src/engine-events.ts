/**
 * engine-events.ts — where engine events go, decided by the host.
 *
 * The engine produces a steady stream of events: transcript entries as they
 * stream, run-state changes, roster edits, MCP status. It must not care who
 * is listening, because that differs entirely by host:
 *
 *  - Desktop: `webContents.send` to every open window.
 *  - Daemon: a broadcast to whichever clients are currently connected —
 *    possibly none, which is the normal state for a routine firing at 3am.
 *
 * "Possibly none" is the important case. A scheduled routine on a headless
 * box has no observer, and the engine must run exactly the same either way.
 * Events are therefore fire-and-forget: a sink that throws is logged and
 * ignored rather than being allowed to fail an agent turn.
 */
import type { BridgeEvent } from '@wispcrew/shared';
import { fileLog } from './filelog.js';

type EventSink = (event: BridgeEvent) => void;

const sinks = new Set<EventSink>();

/**
 * Register a listener. Returns an unsubscribe function.
 *
 * Several may be active at once: the desktop app can hold one while a
 * paired client holds another.
 */
export function addEventSink(sink: EventSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

/**
 * Broadcast an engine event.
 *
 * Never throws. A disconnecting client, a destroyed window or a broken pipe
 * is a delivery problem, not an agent problem — letting it propagate would
 * abort the turn that produced the event.
 */
export function emitEngineEvent(event: BridgeEvent): void {
  for (const sink of sinks) {
    try {
      sink(event);
    } catch (err) {
      fileLog('[events] sink failed', (err as Error).message);
    }
  }
}

/** How many listeners are attached; used for diagnostics only. */
export function sinkCount(): number {
  return sinks.size;
}
