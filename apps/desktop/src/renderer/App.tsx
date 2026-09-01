/**
 * App.tsx — the application shell.
 *
 * Composes the sidebar, the chat view, and the modal panels, and owns the
 * small amount of purely-visual state (which panel is open, theme class).
 * All data lives in `useWispcrew`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconSettings,
  IconHistory,
  IconTrash,
  IconPeople,
  IconSidebar,
} from './Icons.js';
import { useWispcrew } from './useWispcrew';
import { Sidebar, WispMark } from './Sidebar';
import { Chat } from './Chat';
import { RoomPane } from './RoomPane';
import {
  AgentPanel,
  McpPanel,
  NewAgentPanel,
  HistoryPanel,
  RoomPanel,
  NodesPanel,
  RoutinesPanel,
  SettingsPanel,
  SkillsPanel,
} from './Panels';
import type { AgentRecord, HistoryPoint } from '@wispcrew/shared';

type Panel =
  | 'settings'
  | 'agent'
  | 'mcp'
  | 'nodes'
  | 'history'
  | 'routines'
  | 'skills'
  | 'room'
  | 'new-agent'
  | null;

export function App() {
  const { state, actions } = useWispcrew();
  const [panel, setPanel] = useState<Panel>(null);
  /*
   * Loaded when the panel opens rather than kept in sync.
   *
   * Saved versions change only when something destructive happens, so
   * subscribing to them would be churn for an list nobody is looking at.
   */
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  /** Text lifted out of a message the user chose to retry, for the composer. */
  const [retryDraft, setRetryDraft] = useState<string | null>(null);

  const {
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
    grants,
    oauthStatuses,
    detectedSignIns,
    toast,
  } = state;

  /* Theme: honour the setting, defaulting to the OS preference. */
  useEffect(() => {
    const pref = settings?.theme ?? 'system';
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const light = pref === 'light' || (pref === 'system' && mq.matches);
      document.body.classList.toggle('theme-light', light);
    };
    apply();
    if (pref === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [settings?.theme]);

  /* Open Settings from the application menu. */
  useEffect(() => {
    const off = window.wispcrew.onEvent((e) => {
      if ((e as { type: string }).type === 'open-settings') setPanel('settings');
    });
    return off;
  }, []);

  /* Global shortcuts. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === ',') {
        e.preventDefault();
        setPanel('settings');
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setPanel('new-agent');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [actions]);

  /*
   * Slash-command skills are expanded in the main process (see `expandSkill`
   * in main.ts), which is the single source of truth — routines and any other
   * non-UI caller need the same behaviour. The renderer sends the raw text.
   */
  const send = useCallback(
    (prompt: string, attachmentPaths?: string[]) => void actions.send(prompt, attachmentPaths),
    [actions],
  );

  /*
   * The room for the current selection.
   *
   * A migrated room reuses its agent's id, so the same selection identifies
   * both and no second selector is needed.
   */
  const room = useMemo(
    () => state.conversations.find((c) => c.id === selectedId),
    [state.conversations, selectedId],
  );

  /*
   * The other agents sharing each agent's room.
   *
   * Derived here because the sidebar has agents but not conversations, and
   * handing a list component whole conversations would give it the job of
   * understanding rooms.
   *
   * The sidebar is the only place a person sees every conversation at once,
   * so it is the only place the difference between a private chat and a
   * group can be noticed without opening each one — which it could not be:
   * a room holding Nudge and Local Test showed a row saying "Nudge".
   */
  const companions = useMemo(() => {
    /*
     * The id AND the handle. The id seeds each room-mate's avatar; the
     * handle is what the row shows. Carrying handles alone left the stacked
     * avatar with nothing stable to draw the other members from.
     */
    const map: Record<string, { id: string; handle: string }[]> = {};

    for (const conversation of state.conversations) {
      const members = conversation.participants.filter((p) => p.kind === 'agent');
      // One agent is not company; that is the ordinary chat.
      if (members.length < 2) continue;

      for (const self of members) {
        map[self.id] = members
          .filter((p) => p.id !== self.id)
          .map((p) => ({ id: p.id, handle: p.handle }));
      }
    }

    return map;
  }, [state.conversations]);

  /*
   * Rooms the user has actually named.
   *
   * A conversation's title defaults to its first agent's name, so showing
   * every title would change nothing for most rows and would go stale the
   * moment that agent was renamed. Only a title that DIFFERS is a name
   * somebody chose.
   *
   * Declared up here with the other memos, above the `if (!ready)` early
   * return. Placed below it, this hook ran only on some renders — React
   * counts hooks by call order, so the first paint after startup rendered
   * more than the boot screen had and the whole window went blank. It
   * typechecked perfectly; only launching the app showed it.
   */
  const roomTitles = useMemo(() => {
    const map: Record<string, string> = {};

    for (const conversation of state.conversations) {
      const owner = agents.find((a) => a.id === conversation.id);
      if (conversation.title && conversation.title !== owner?.name) {
        map[conversation.id] = conversation.title;
      }
    }

    return map;
  }, [state.conversations, agents]);

  /*
   * A mention the composer should insert.
   *
   * Clicking a participant types their handle rather than sending anything:
   * the user is usually part-way through a sentence, and sending on click
   * would lose it.
   */
  const [draftMention, setDraftMention] = useState<string | null>(null);

  /*
   * The side panel, open by default.
   *
   * Not hidden until asked for: a panel nobody knows about is a panel nobody
   * uses, and its content — who is working, what is scheduled — is exactly
   * what someone wants without having to think to look.
   */
  const [paneOpen, setPaneOpen] = useState(true);

  /*
   * Ask again when the Machines panel opens.
   *
   * Reachability is knowable only from a live link, and links are opened in
   * the background after startup — so the list fetched at launch says "not
   * reachable" for a node that connects a moment later, and keeps saying it.
   * A user then sees a machine they can demonstrably use described as
   * unreachable, with no indication that the answer is simply old.
   */
  useEffect(() => {
    if (panel === 'nodes') void actions.refreshNodes();
  }, [panel, actions]);

  const configuredServers = useMemo(() => settings?.mcpServers ?? [], [settings?.mcpServers]);

  /*
   * A provider is usable with either an API key or a subscription sign-in.
   * Checking only for a key would leave a signed-in user staring at "set up"
   * with no way to dismiss it.
   */
  const hasSignIn = oauthStatuses.some((s) => s.signedIn);
  const hasProvider = Boolean(settings?.hasApiKey) || hasSignIn;

  /* First run: nothing configured yet, by either route. */
  const needsOnboarding = ready && settings && !hasProvider && !settings.onboarded;

  /*
   * If a CLI on this machine is already signed in, say so — it turns a
   * "paste an API key" chore into one click. Offered, never assumed: the
   * user still chooses it in Settings, where the risk is stated.
   */
  const availableCli = detectedSignIns.find((d) => d.available);

  if (!ready) {
    return (
      <div className="boot">
        <WispMark size={44} />
        <p className="muted">Starting WispCrew…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        companions={companions}
        roomTitles={roomTitles}
        selectedId={selectedId}
        runStates={runStates}
        onSelect={actions.selectAgent}
        onCreate={() => setPanel('new-agent')}
        onOpenSettings={() => setPanel('settings')}
        onOpenPanel={setPanel}
      />

      <main className="main">
        {/*
          The conversation column: header, membership strip, transcript and
          composer, stacked. The side panel is its sibling, which is why the
          wrapper starts HERE and not after the header — leaving the header
          outside it put the title in the middle of the window.
        */}
        <div className="chat-column">
        <header className="topbar">
          <div className="topbar-title">
            <strong>{selected?.name ?? 'WispCrew'}</strong>
            {selected && (
              <span className="muted topbar-sub">
                {selected.model || settings?.model || 'default model'}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            {selected && (
              <>
                <button type="button" className="btn" onClick={() => setPanel('agent')}>
                  <IconSettings />
                  Configure
                </button>
                {/* Beside Clear chat on purpose: this is where someone
                    realises they have lost something and looks for a way
                    back. */}
                <button type="button" className="btn" onClick={() => {
                    void actions.listHistory().then(setHistoryPoints);
                    setPanel('history');
                  }}>
                  <IconHistory />
                  History
                </button>
                {/*
                  The only destructive control up here, so it is the only one
                  that reads as dangerous. Marked by class rather than colour
                  alone — `btn-danger` also carries a hover state, and colour
                  by itself is not a signal everyone receives.
                */}
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void actions.clearConversation()}
                  disabled={transcript.length === 0}
                >
                  <IconTrash />
                  Clear chat
                </button>
              </>
            )}
          </div>
        </header>

        {/*
          Who is in this room.

          Shown inline rather than behind a modal: membership is context you
          want WHILE typing, because knowing @linux is present is what tells
          you the handle exists. Hidden entirely for a room with one agent,
          which is still the common case and needs no explanation.
        */}
        {room && (
          <div className="room-strip">
            {room.participants.filter((p) => p.kind === 'agent').length > 1 ? (
              <span className="muted small">In this room:</span>
            ) : (
              /*
               * One agent: say what the button is FOR.
               *
               * Listing a single handle would be noise, but hiding the strip
               * entirely made Members unreachable — and Members is how the
               * second agent gets added. So the row stays and explains
               * itself instead.
               */
              <span className="muted small">Add an agent to work together in this conversation.</span>
            )}
            {room.participants.filter((p) => p.kind === 'agent').length > 1 &&
              room.participants
                .filter((p) => p.kind === 'agent')
                .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="room-chip"
                  title="Insert a mention"
                  onClick={() => setDraftMention(`@${(p as { handle: string }).handle}`)}
                >
                  @{(p as { handle: string }).handle}
                </button>
              ))}
            <span className="room-strip-spacer" />

            {/*
              A real choice with three options, so it stays a select — but
              wrapped, because a bare native control is the one element on
              this screen the app has no say over. The wrapper draws the
              border and the caret; the select itself goes transparent.
            */}
            <label className="room-mode-field" title="How much the room constrains who speaks">
              <span className="room-mode-label">Who speaks</span>
              <select
                className="room-mode"
                value={room.mode}
                onChange={(e) => void actions.setRoomMode(e.target.value)}
              >
                <option value="directed">Directed</option>
                <option value="open">Open</option>
                <option value="free">Free</option>
              </select>
            </label>

            {/*
              Icon buttons from here on. These two are toggles a person
              reaches for repeatedly and already understands — spending a
              full outlined button on each crowded the row and left the
              agent's own name competing with them for attention.

              Icon-only means each carries its name for assistive tech and a
              tooltip for everyone else.
            */}
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPanel('room')}
              title="Who is in this room"
              aria-label="Who is in this room"
            >
              <IconPeople />
            </button>

            {/*
              Toggling the pane, rather than only ever hiding it. Its close
              button leaves no way back otherwise, which is the small trap
              that makes people stop using a panel.
            */}
            <button
              type="button"
              className={`icon-btn${paneOpen ? ' icon-btn-on' : ''}`}
              onClick={() => setPaneOpen((open) => !open)}
              title={paneOpen ? 'Hide the side panel' : 'Show who is here and what is scheduled'}
              aria-label={paneOpen ? 'Hide the side panel' : 'Show the side panel'}
              aria-pressed={paneOpen}
            >
              <IconSidebar />
            </button>
          </div>
        )}

        {needsOnboarding && (
          <div className="onboard-banner">
            <div>
              <strong>Welcome to WispCrew.</strong> Choose a model provider and paste an API key to
              begin — your key is stored encrypted on this machine and sent only to the provider you
              pick.
              {availableCli && (
                <>
                  {' '}
                  You are already signed in to <strong>{availableCli.source}</strong>
                  {availableCli.plan ? ` (${availableCli.plan} plan)` : ''} on this machine — you can
                  use that instead of a key.
                </>
              )}
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setPanel('settings')}>
              Open settings
            </button>
          </div>
        )}

        <Chat
          agent={selected}
          transcript={transcript}
          runState={runState}
          skills={skills}
          /*
            Who can be addressed here. Empty for a room with one agent —
            there is nobody to disambiguate between, and offering a mention
            of the only participant is noise.
          */
          members={
            room && room.participants.filter((p) => p.kind === 'agent').length > 1
              ? room.participants
                  .filter((p) => p.kind === 'agent')
                  .map((p) => ({
                    id: p.id,
                    handle: (p as { handle: string }).handle,
                    name: agents.find((a) => a.id === p.id)?.name ?? p.id,
                  }))
              : []
          }
          onOpenRoutines={() => setPanel('routines')}
          onOpenHistory={() => setPanel('history')}
          onOpenRoom={() => setPanel('room')}
          onSend={send}
          insertText={draftMention}
          onInsertConsumed={() => setDraftMention(null)}
          onInterrupt={() => void actions.interrupt()}
          onResolveApproval={(id, res) => void actions.resolveApproval(id, res)}
          onOpenSettings={() => setPanel('settings')}
          onPickFiles={actions.pickFiles}
          onRewind={(id, mode) => {
            void actions.rewind(id, mode).then((text) => {
              // "Retry from here" hands the removed text back so the user can
              // rephrase instead of retyping it.
              if (text) setRetryDraft(text);
            });
          }}
          onBranch={(id) => void actions.branch(id)}
          retryDraft={retryDraft}
          onRetryDraftConsumed={() => setRetryDraft(null)}
          onCreateAgent={() => setPanel('new-agent')}
          hasProvider={hasProvider}
        />
        </div>

        {/*
          Who is here, and what is scheduled for them.
          
          Shown for a single agent too: a routine belongs to ONE agent, and
          hiding the pane for a one-member room would hide the only thing
          worth showing — which is the same mistake as hiding the members
          strip, made once already.
        */}
        {room && paneOpen && (
          <RoomPane
            room={room}
            agents={agents}
            routines={routines}
            runStates={runStates}
            onMention={(handle) => setDraftMention(`@${handle}`)}
            onRename={(title) => void actions.renameConversation(room.id, title)}
            onOpenRoutines={() => setPanel('routines')}
            onClose={() => setPaneOpen(false)}
          />
        )}
      </main>

      {toast && (
        <div
          className={`toast toast-${toast.level}`}
          onClick={actions.dismissToast}
          // Errors interrupt; informational toasts wait for a pause.
          role={toast.level === 'error' ? 'alert' : 'status'}
          aria-live={toast.level === 'error' ? 'assertive' : 'polite'}
        >
          {toast.text}
        </div>
      )}

      {panel === 'new-agent' && (
        <NewAgentPanel
          presets={presets}
          defaultPresetId={settings?.presetId}
          onCreate={(patch: Partial<AgentRecord>) => void actions.createAgent(patch)}
          onOpenSettings={() => setPanel('settings')}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'settings' && settings && (
        <SettingsPanel
          settings={settings}
          presets={presets}
          personas={personas}
          grants={grants}
          agentName={(id) => agents.find((a) => a.id === id)?.name ?? 'a deleted agent'}
          onRevokeGrant={(id, tool) => void actions.revokeGrant(id, tool)}
          onRevokeAllGrants={() => void actions.revokeAllGrants()}
          oauthStatuses={oauthStatuses}
          detectedSignIns={detectedSignIns}
          onOAuthSignIn={actions.oauthSignIn}
          onOAuthImport={actions.oauthImport}
          onOAuthSignOut={(v) => void actions.oauthSignOut(v)}
          onSave={actions.saveSettings}
          onTest={actions.testConnection}
          onPickDirectory={actions.pickDirectory}
          onTestTelegram={actions.testTelegram}
          onDiscoverChatId={actions.discoverChatId}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'agent' && selected && (
        <AgentPanel
          globalPolicy={state.settings?.approvalPolicy}
          agent={selected}
          nodes={state.nodes}
          presets={presets}
          personas={personas}
          onSave={(patch) => void actions.updateAgent(selected.id, patch)}
          onDelete={() => {
            void actions.deleteAgent(selected.id);
            setPanel(null);
          }}
          onDuplicate={() => {
            void actions.duplicateAgent(selected.id);
            setPanel(null);
          }}
          onPickDirectory={actions.pickDirectory}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'room' && room && (
        <RoomPanel
          room={room}
          agents={state.agents}
          onAdd={(id) => void actions.addRoomAgent(id)}
          onRemove={(id) => void actions.removeRoomParticipant(id)}
          onSetMode={(mode) => void actions.setRoomMode(mode)}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'history' && (
        <HistoryPanel
          points={historyPoints}
          onRestore={actions.restoreHistory}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'nodes' && (
        <NodesPanel
          nodes={state.nodes}
          agents={agents}
          onPair={actions.pairNode}
          onForget={actions.forgetNode}
          onRefresh={() => void actions.refreshNodes()}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'mcp' && (
        <McpPanel
          servers={mcpServers}
          configured={configuredServers}
          onAdd={actions.addMcpServer}
          onUpdate={(name, patch) => void actions.updateMcpServer(name, patch)}
          onRemove={(name) => void actions.removeMcpServer(name)}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'routines' && (
        <RoutinesPanel
          routines={routines}
          agents={agents}
          onCreate={(patch) => void actions.createRoutine(patch)}
          onUpdate={(id, patch) => void actions.updateRoutine(id, patch)}
          onDelete={(id) => void actions.deleteRoutine(id)}
          onRunNow={(id) => void actions.runRoutineNow(id)}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'skills' && (
        <SkillsPanel
          skills={skills}
          onCreate={(patch) => void actions.createSkill(patch)}
          onUpdate={(id, patch) => void actions.updateSkill(id, patch)}
          onDelete={(id) => void actions.deleteSkill(id)}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
