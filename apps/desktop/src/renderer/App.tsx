/**
 * App.tsx — the application shell.
 *
 * Composes the sidebar, the chat view, and the modal panels, and owns the
 * small amount of purely-visual state (which panel is open, theme class).
 * All data lives in `useGhostbot`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGhostbot } from './useGhostbot';
import { Sidebar, GhostMark } from './Sidebar';
import { Chat } from './Chat';
import {
  AgentPanel,
  McpPanel,
  NewAgentPanel,
  NodesPanel,
  RoutinesPanel,
  SettingsPanel,
  SkillsPanel,
} from './Panels';
import type { AgentRecord } from '@ghostbot/shared';

type Panel =
  | 'settings'
  | 'agent'
  | 'mcp'
  | 'nodes'
  | 'routines'
  | 'skills'
  | 'new-agent'
  | null;

export function App() {
  const { state, actions } = useGhostbot();
  const [panel, setPanel] = useState<Panel>(null);
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
    const off = window.ghostbot.onEvent((e) => {
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
        <GhostMark size={44} />
        <p className="muted">Starting GhostBot…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        runStates={runStates}
        onSelect={actions.selectAgent}
        onCreate={() => setPanel('new-agent')}
        onOpenSettings={() => setPanel('settings')}
        onOpenPanel={setPanel}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <strong>{selected?.name ?? 'GhostBot'}</strong>
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
                  Configure
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void actions.clearConversation()}
                  disabled={transcript.length === 0}
                >
                  Clear chat
                </button>
              </>
            )}
          </div>
        </header>

        {needsOnboarding && (
          <div className="onboard-banner">
            <div>
              <strong>Welcome to GhostBot.</strong> Choose a model provider and paste an API key to
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
          onSend={send}
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
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'agent' && selected && (
        <AgentPanel
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
