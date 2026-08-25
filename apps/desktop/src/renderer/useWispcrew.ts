/**
 * useWispcrew.ts — the renderer's single source of truth.
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
  DetectedSignIn,
  McpServerStatus,
  NodeSummary,
  OAuthStatusView,
  PersonaView,
  PresetView,
  RoutineRecord,
  SettingsView,
  SkillRecord,
  ToolGrant,
  TranscriptEntry,
} from '@wispcrew/shared';

/** Transcript entries capped in memory; the store keeps the durable history. */
const MAX_RENDERED_ENTRIES = 500;

export interface WispcrewState {
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
  /** Machines paired with this client; empty until the user attaches one. */
  nodes: NodeSummary[];
  routines: RoutineRecord[];
  skills: SkillRecord[];
  /** Transient banner messages (errors from the bridge, notices from main). */
  toast: { level: 'info' | 'error'; text: string } | null;
}

export function useWispcrew() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [runStates, setRunStates] = useState<Record<string, AgentRunState>>({});
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [grants, setGrants] = useState<ToolGrant[]>([]);
  const [oauthStatuses, setOauthStatuses] = useState<OAuthStatusView[]>([]);
  const [detectedSignIns, setDetectedSignIns] = useState<DetectedSignIn[]>([]);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<WispcrewState['toast']>(null);

  // The event handler needs the current selection without re-subscribing on
  // every change, so it reads from a ref rather than a closure capture.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Actions need the current transcript without being rebuilt on every
  // streamed token, which would re-render the whole tree each frame.
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  transcriptRef.current = transcript;

  const api = window.wispcrew;

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
        const [a, s, p, pe, m, r, sk, gr, oa, det, nd] = await Promise.all([
          api.listAgents(),
          api.getSettings(),
          api.getPresets(),
          api.getPersonas(),
          api.listMcpServers(),
          api.listRoutines(),
          api.listSkills(),
          api.listToolGrants(),
          api.listOAuthStatus(),
          api.listDetectedCliSignIns(),
          api.listNodes(),
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
        setGrants(arr<ToolGrant>(gr));
        setOauthStatuses(arr<OAuthStatusView>(oa));
        setDetectedSignIns(arr<DetectedSignIn>(det));
        setNodes(arr<NodeSummary>(nd));
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
        case 'grants-changed':
          setGrants(event.grants);
          return;
        case 'oauth-changed':
          setOauthStatuses(event.statuses);
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

    /*
     * Clear before fetching, not after.
     *
     * Loading is asynchronous, so for as long as it takes the transcript
     * still holds the *previous* agent's messages. Streaming events for the
     * newly selected agent arrive in that window and were appended to them,
     * so switching mid-run showed two conversations spliced together — and
     * because the fetch then overwrote everything, whether you saw it
     * depended entirely on timing.
     *
     * Showing an empty conversation for a moment is honest; showing someone
     * else's messages is not.
     */
    setTranscript([]);

    let cancelled = false;
    void api
      .getTranscript(selectedId, MAX_RENDERED_ENTRIES)
      .then((entries) => {
        // A second switch while this was in flight must win, or the slower
        // request would clobber the newer agent's conversation.
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

      /** Confirm Telegram works by sending a real message. */
      async testTelegram() {
        try {
          return await api.testTelegram();
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },

      async discoverChatId() {
        try {
          return await api.discoverChatId();
        } catch {
          return null;
        }
      },

      /** Earlier versions of the selected conversation, newest first. */
      async listHistory() {
        if (!selectedRef.current) return [];
        try {
          return await api.listHistory(selectedRef.current);
        } catch (err) {
          fail(err);
          return [];
        }
      },

      /**
       * Put a saved version back.
       *
       * The restored entries come back from the call, so the view updates
       * without a second round trip — and without depending on an event that
       * a remote node would have to emit.
       */
      async restoreHistory(file: string) {
        if (!selectedRef.current) return false;
        try {
          const entries = await api.restoreHistory(selectedRef.current, file);
          setTranscript(Array.isArray(entries) ? entries : []);
          return true;
        } catch (err) {
          fail(err);
          return false;
        }
      },

      /**
       * Rewind, then optionally resend. `before` is "edit and retry": the
       * named message is dropped and its text handed back so the composer can
       * be prefilled, letting the user rephrase rather than retype.
       */
      async rewind(entryId: string, mode: 'through' | 'before') {
        const agentId = selectedRef.current;
        if (!agentId) return null;
        try {
          const removed =
            mode === 'before'
              ? transcriptRef.current.find((e) => e.id === entryId)
              : undefined;
          const kept = await api.rewindConversation(agentId, entryId, mode);
          setTranscript(Array.isArray(kept) ? kept : []);
          return removed && removed.kind === 'message' ? removed.content : null;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      async branch(entryId: string) {
        const agentId = selectedRef.current;
        if (!agentId) return;
        try {
          const created = await api.branchConversation(agentId, entryId);
          setSelectedId(created.id);
          setToast({ level: 'info', text: `Branched into "${created.name}".` });
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

      /**
       * Pair with a machine that is showing a code.
       *
       * Returns the error message rather than a boolean, because pairing
       * fails for reasons the user can act on — a mistyped code, an
       * unreachable host, a fingerprint that does not match — and "it didn't
       * work" would leave them guessing which.
       */
      async pairNode(address: string, code: string, expectFingerprint?: string) {
        try {
          await api.pairNode(address, code, expectFingerprint);
          setNodes(await api.listNodes());
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },

      async forgetNode(nodeId: string) {
        try {
          setNodes(await api.forgetNode(nodeId));
          // Agents that lived there are now unreachable, so refresh the
          // roster to show it rather than leaving a stale "ready" state.
          setAgents(await api.listAgents());
          return true;
        } catch (err) {
          fail(err);
          return false;
        }
      },

      async refreshNodes() {
        try {
          setNodes(await api.listNodes());
        } catch (err) {
          fail(err);
        }
      },

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

      /**
       * Sign-in actions return an error *message* rather than throwing, so
       * the settings panel can show it inline beside the button the user
       * just pressed instead of as a detached toast.
       */
      async oauthSignIn(vendor: 'anthropic' | 'chatgpt'): Promise<string | null> {
        try {
          await api.oauthSignIn(vendor);
          setOauthStatuses(await api.listOAuthStatus());
          setSettings(await api.getSettings());
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },

      async oauthImport(vendor: 'anthropic' | 'chatgpt'): Promise<string | null> {
        try {
          await api.oauthImportFromCli(vendor);
          setOauthStatuses(await api.listOAuthStatus());
          setSettings(await api.getSettings());
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },

      async oauthSignOut(vendor: 'anthropic' | 'chatgpt') {
        try {
          setOauthStatuses(await api.oauthSignOut(vendor));
          setSettings(await api.getSettings());
        } catch (err) {
          fail(err);
        }
      },

      async revokeGrant(agentId: string, toolName: string) {
        try {
          setGrants(await api.revokeToolGrant(agentId, toolName));
        } catch (err) {
          fail(err);
        }
      },

      async revokeAllGrants() {
        try {
          setGrants(await api.revokeAllToolGrants());
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
      nodes,
      routines,
      skills,
      grants,
      oauthStatuses,
      detectedSignIns,
      toast,
    },
    actions,
  };
}
