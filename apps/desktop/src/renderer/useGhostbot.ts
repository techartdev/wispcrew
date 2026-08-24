/**
 * useGhostbot.ts — the renderer's single source of truth.
 *
 * All app state lives here: the agent roster, the selected agent, its
 * transcript, run state, settings, MCP servers, routines, and skills. The
 * hook subscribes once to the main process's push events and applies them
 * incrementally, so the UI updates at token speed without polling.
 *
 * Why one hook rather than a state library: the state is small, the update
 * rules are simple, and every mutation flows through the same bridge. Adding
 * Redux/Zustand here would be ceremony without benefit — and every dependency
 * in an app that executes shell commands is a supply-chain decision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentRecord,
  AgentRunState,
  BridgeEvent,
  McpServerStatus,
  PersonaView,
  PresetView,
  RoutineRecord,
  SettingsView,
  SkillRecord,
  TranscriptEntry,
} from '@ghostbot/shared';

/** Transcript entries capped in memory; the store keeps the durable history. */
const MAX_RENDERED_ENTRIES = 500;

export interface GhostbotState {
  ready: boolean;
  agents: AgentRecord[];
  selectedId: string | null;
  selected: AgentRecord | null;
  transcript: TranscriptEntry[];
  runState: AgentRunState;
  settings: SettingsView | null;
  presets: PresetView[];
  personas: PersonaView[];
  mcpServers: McpServerStatus[];
  routines: RoutineRecord[];
  skills: SkillRecord[];
  /** Transient banner messages (errors from the bridge, notices from main). */
  toast: { level: 'info' | 'error'; text: string } | null;
}

export function useGhostbot() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [runStates, setRunStates] = useState<Record<string, AgentRunState>>({});
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<GhostbotState['toast']>(null);

  // The event handler needs the current selection without re-subscribing on
  // every change, so it reads from a ref rather than a closure capture.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const api = window.ghostbot;

  /** Surface an error to the user instead of losing it in the console. */
  const fail = useCallback((err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    setToast({ level: 'error', text });
  }, []);

  /* -- initial load --------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [a, s, p, pe, m, r, sk] = await Promise.all([
          api.listAgents(),
          api.getSettings(),
          api.getPresets(),
          api.getPersonas(),
          api.listMcpServers(),
          api.listRoutines(),
          api.listSkills(),
        ]);
        if (cancelled) return;
        // Defence in depth: main already repairs malformed stores, but a
        // non-array reaching a `.find`/`.map` here blanks the whole window
        // with only "find is not a function" in the console. Bad data must
        // degrade to an empty list, never a dead UI.
        const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
        const agentList = arr<AgentRecord>(a);
        setAgents(agentList);
        setSettings(s);
        setPresets(arr<PresetView>(p));
        setPersonas(arr<PersonaView>(pe));
        setMcpServers(arr<McpServerStatus>(m));
        setRoutines(arr<RoutineRecord>(r));
        setSkills(arr<SkillRecord>(sk));
        setSelectedId((prev) => prev ?? agentList[0]?.id ?? null);
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          fail(err);
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, fail]);

  /* -- push events ---------------------------------------------- */

  useEffect(() => {
    const off = api.onEvent((event: BridgeEvent) => {
      switch (event.type) {
        case 'transcript': {
          // Only the visible conversation is kept in renderer state; other
          // agents' entries are already persisted and load on selection.
          if (event.agentId !== selectedRef.current) return;
          setTranscript((prev) => {
            const idx = prev.findIndex((e) => e.id === event.entry.id);
            const next = idx === -1 ? [...prev, event.entry] : prev.slice();
            if (idx !== -1) next[idx] = event.entry;
            return next.length > MAX_RENDERED_ENTRIES
              ? next.slice(next.length - MAX_RENDERED_ENTRIES)
              : next;
          });
          return;
        }
        case 'run-state':
          setRunStates((prev) => ({ ...prev, [event.agentId]: event.state }));
          return;
        case 'agents-changed':
          setAgents(event.agents);
          // If the selected agent was deleted elsewhere, fall back to the first.
          setSelectedId((prev) =>
            prev && event.agents.some((a) => a.id === prev) ? prev : (event.agents[0]?.id ?? null),
          );
          return;
        case 'mcp-changed':
          setMcpServers(event.servers);
          return;
        case 'routines-changed':
          setRoutines(event.routines);
          return;
        case 'notice':
          setToast({ level: event.level, text: event.text });
          return;
        default:
          return;
      }
    });
    return off;
  }, [api]);

  /* -- transcript loading on selection --------------------------- */

  useEffect(() => {
    if (!selectedId) {
      setTranscript([]);
      return;
    }
    let cancelled = false;
    void api
      .getTranscript(selectedId, MAX_RENDERED_ENTRIES)
      .then((entries) => {
        if (!cancelled) setTranscript(entries);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [api, selectedId, fail]);

  /* -- auto-dismiss toasts --------------------------------------- */

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.level === 'error' ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /* -- actions --------------------------------------------------- */

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const runState: AgentRunState = selectedId ? (runStates[selectedId] ?? 'idle') : 'idle';

  const actions = useMemo(
    () => ({
      selectAgent: setSelectedId,

      async createAgent(patch: Partial<AgentRecord> = {}) {
        try {
          const created = await api.createAgent(patch);
          setSelectedId(created.id);
          return created;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      async updateAgent(id: string, patch: Partial<AgentRecord>) {
        try {
          await api.updateAgent(id, patch);
        } catch (err) {
          fail(err);
        }
      },

      async deleteAgent(id: string) {
        try {
          await api.deleteAgent(id);
        } catch (err) {
          fail(err);
        }
      },

      async duplicateAgent(id: string) {
        try {
          await api.duplicateAgent(id);
        } catch (err) {
          fail(err);
        }
      },

      async send(prompt: string, attachmentPaths?: string[]) {
        if (!selectedRef.current) return;
        try {
          await api.sendPrompt(selectedRef.current, prompt, attachmentPaths);
        } catch (err) {
          fail(err);
        }
      },

      pickFiles: api.pickFiles,

      async interrupt() {
        if (!selectedRef.current) return;
        try {
          await api.interrupt(selectedRef.current);
        } catch (err) {
          fail(err);
        }
      },

      async clearConversation() {
        if (!selectedRef.current) return;
        try {
          await api.clearConversation(selectedRef.current);
          setTranscript([]);
        } catch (err) {
          fail(err);
        }
      },

      async resolveApproval(requestId: string, resolution: 'allow-once' | 'allow-always' | 'deny') {
        try {
          await api.resolveApproval(requestId, resolution);
        } catch (err) {
          fail(err);
        }
      },

      async saveSettings(patch: Parameters<typeof api.saveSettings>[0]) {
        try {
          const next = await api.saveSettings(patch);
          setSettings(next);
          return next;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      testConnection: api.testConnection,
      pickDirectory: api.pickDirectory,
      getAppInfo: api.getAppInfo,

      async addMcpServer(server: Parameters<typeof api.addMcpServer>[0]) {
        try {
          setMcpServers(await api.addMcpServer(server));
          return true;
        } catch (err) {
          fail(err);
          return false;
        }
      },

      async updateMcpServer(name: string, patch: Parameters<typeof api.updateMcpServer>[1]) {
        try {
          setMcpServers(await api.updateMcpServer(name, patch));
        } catch (err) {
          fail(err);
        }
      },

      async removeMcpServer(name: string) {
        try {
          setMcpServers(await api.removeMcpServer(name));
        } catch (err) {
          fail(err);
        }
      },

      async createRoutine(patch: Parameters<typeof api.createRoutine>[0]) {
        try {
          await api.createRoutine(patch);
        } catch (err) {
          fail(err);
        }
      },

      async updateRoutine(id: string, patch: Partial<RoutineRecord>) {
        try {
          await api.updateRoutine(id, patch);
        } catch (err) {
          fail(err);
        }
      },

      async deleteRoutine(id: string) {
        try {
          await api.deleteRoutine(id);
        } catch (err) {
          fail(err);
        }
      },

      async runRoutineNow(id: string) {
        try {
          await api.runRoutineNow(id);
        } catch (err) {
          fail(err);
        }
      },

      async createSkill(patch: Partial<SkillRecord>) {
        try {
          const created = await api.createSkill(patch);
          setSkills((prev) => [...prev, created]);
        } catch (err) {
          fail(err);
        }
      },

      async updateSkill(id: string, patch: Partial<SkillRecord>) {
        try {
          const updated = await api.updateSkill(id, patch);
          setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
        } catch (err) {
          fail(err);
        }
      },

      async deleteSkill(id: string) {
        try {
          await api.deleteSkill(id);
          setSkills((prev) => prev.filter((s) => s.id !== id));
        } catch (err) {
          fail(err);
        }
      },

      dismissToast: () => setToast(null),
      notify: (text: string, level: 'info' | 'error' = 'info') => setToast({ level, text }),
    }),
    [api, fail],
  );

  return {
    state: {
      ready,
      agents,
      selectedId,
      selected,
      transcript,
      runState,
      runStates,
      settings,
      presets,
      personas,
      mcpServers,
      routines,
      skills,
      toast,
    },
    actions,
  };
}
