/**
 * Panels.tsx — the modal panels: Settings, Plugins (MCP), Routines, Skills,
 * and per-agent configuration.
 *
 * These are deliberately plain forms. The value of this app is the agent
 * loop and the provider freedom, not chrome; a settings screen that is
 * obvious beats one that is clever.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentRecord,
  ApprovalPolicy,
  GlobalSettings,
  McpServerRecord,
  McpServerStatus,
  PersonaView,
  PresetView,
  RoutineRecord,
  SettingsView,
  SkillRecord,
  ToolGrant,
} from '@ghostbot/shared';

/* ------------------------------------------------------------------ */
/* Modal shell                                                         */
/* ------------------------------------------------------------------ */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * Escape closes, and Tab is trapped inside the dialog.
   *
   * Without the trap, tabbing walks out of an `aria-modal` dialog into the
   * page behind it — the focus ring disappears somewhere invisible and
   * keyboard users are stranded. Focus is also moved into the dialog on open
   * and returned to the trigger on close, so the keyboard position does not
   * jump to the top of the document.
   */
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // Focus the first control rather than the dialog itself, so the first
    // Tab moves to the second control instead of re-entering at the start.
    focusable()[0]?.focus();

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

interface SettingsPanelProps {
  settings: SettingsView;
  presets: PresetView[];
  personas: PersonaView[];
  /** Standing "always allow" permissions, so the user can review them. */
  grants: ToolGrant[];
  /** Resolves an agent id to its display name for the grants list. */
  agentName(agentId: string): string;
  onRevokeGrant(agentId: string, toolName: string): void;
  onRevokeAllGrants(): void;
  onSave(patch: Partial<GlobalSettings> & { apiKey?: string }): Promise<unknown>;
  onTest(cfg: {
    presetId: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
  onPickDirectory(): Promise<string | null>;
  onClose(): void;
}

export function SettingsPanel({
  settings,
  presets,
  personas,
  grants,
  agentName,
  onRevokeGrant,
  onRevokeAllGrants,
  onSave,
  onTest,
  onPickDirectory,
  onClose,
}: SettingsPanelProps) {
  const [presetId, setPresetId] = useState(settings.presetId ?? 'deepseek');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model ?? '');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
  const [persona, setPersona] = useState(settings.persona ?? 'general');
  const [workspaceRoot, setWorkspaceRoot] = useState(settings.workspaceRoot ?? '');
  const [policy, setPolicy] = useState<ApprovalPolicy>(settings.approvalPolicy ?? 'ask');
  const [theme, setTheme] = useState(settings.theme ?? 'system');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const preset = useMemo(() => presets.find((p) => p.id === presetId), [presets, presetId]);

  // Switching provider swaps in that provider's defaults rather than leaving
  // a model name from the previous provider that will 404.
  const choosePreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    setModel(p?.defaultModel ?? '');
    setBaseUrl(p?.baseUrl ?? '');
    setResult(null);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    const r = await onTest({ presetId, apiKey: apiKey || undefined, model, baseUrl });
    setResult({
      ok: r.ok,
      text: r.ok ? `Connected in ${r.latencyMs ?? 0} ms` : (r.error ?? 'Connection failed'),
    });
    setTesting(false);
  };

  const save = async () => {
    setSaving(true);
    await onSave({
      presetId,
      model: model || undefined,
      baseUrl: baseUrl || undefined,
      persona,
      workspaceRoot: workspaceRoot || undefined,
      approvalPolicy: policy,
      theme,
      onboarded: true,
      ...(apiKey ? { apiKey } : {}),
    });
    setSaving(false);
    onClose();
  };

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <section className="panel-section">
        <h3>Model provider</h3>
        <div className="provider-grid">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`provider-card ${p.id === presetId ? 'selected' : ''}`}
              onClick={() => choosePreset(p.id)}
            >
              <span className="provider-name">{p.label}</span>
              <span className="provider-kind">{p.local ? 'local' : 'cloud'}</span>
            </button>
          ))}
        </div>

        <label className="field">
          <span>
            API key{' '}
            {settings.hasApiKey && (
              <em className="muted">
                — a key is stored{settings.isEncrypted ? ' (encrypted)' : ' (unencrypted)'}; leave
                blank to keep it
              </em>
            )}
          </span>
          <input
            type="password"
            value={apiKey}
            placeholder={preset?.local ? 'Not required for local endpoints' : (preset?.keyHint ?? '')}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {!settings.isEncrypted && (
          <p className="warn-inline">
            This system reports no OS keychain, so keys are stored in a permission-restricted
            plaintext file rather than encrypted.
          </p>
        )}

        <div className="field-row">
          <label className="field">
            <span>Model</span>
            <input
              list="model-options"
              value={model}
              placeholder={preset?.defaultModel}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
            <datalist id="model-options">
              {(preset?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              value={baseUrl}
              placeholder={preset?.baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>

        <div className="row-actions">
          <button type="button" className="btn" onClick={() => void test()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {result && (
            <span className={result.ok ? 'test-ok' : 'test-bad'}>{result.text}</span>
          )}
        </div>
      </section>

      <section className="panel-section">
        <h3>Defaults for new agents</h3>
        <label className="field">
          <span>Persona</span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.description}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Workspace folder (file and shell tools are confined here)</span>
          <div className="field-row">
            <input
              value={workspaceRoot}
              placeholder="Choose a folder…"
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void onPickDirectory().then((d) => d && setWorkspaceRoot(d))}
            >
              Browse…
            </button>
          </div>
        </label>
      </section>

      <section className="panel-section">
        <h3>Tool permissions</h3>
        <div className="radio-list">
          {(
            [
              ['ask', 'Ask every time', 'Read-only tools run freely; writing or running commands needs your approval.'],
              ['auto', 'Run without asking', 'The agent may write files and run shell commands unattended.'],
              ['readonly', 'Read-only', 'Never write files or run commands, even if asked.'],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className={`radio-row ${policy === value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="policy"
                checked={policy === value}
                onChange={() => setPolicy(value as ApprovalPolicy)}
              />
              <span>
                <strong>{label}</strong>
                <span className="muted"> — {help}</span>
              </span>
            </label>
          ))}
        </div>
        {policy === 'auto' && (
          <p className="warn-inline">
            The agent will be able to run shell commands and modify files without confirmation.
            Only use this in a workspace you are willing to lose.
          </p>
        )}
      </section>

      <section className="panel-section">
        <h3>Standing permissions</h3>
        {grants.length === 0 ? (
          <p className="muted">
            None. When you choose “Always allow” on a permission prompt, it is
            recorded here so you can review or withdraw it later.
          </p>
        ) : (
          <>
            <p className="muted">
              These tools run without asking. Revoke any you no longer want.
            </p>
            <div className="list">
              {grants.map((g) => (
                <div key={`${g.agentId}\u0000${g.toolName}`} className="list-row">
                  <div className="list-main">
                    <div className="list-title">
                      <code>{g.toolName}</code>
                      <span className="muted">
                        {' '}
                        — {agentName(g.agentId)}
                      </span>
                    </div>
                    <div className="muted list-sub">
                      Granted {new Date(g.grantedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="list-actions">
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => onRevokeGrant(g.agentId, g.toolName)}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="row-actions">
              <button type="button" className="btn btn-danger" onClick={onRevokeAllGrants}>
                Revoke all
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel-section">
        <h3>Appearance</h3>
        <label className="field">
          <span>Theme</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
            <option value="system">Follow system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </section>

      <footer className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Agent configuration                                                 */
/* ------------------------------------------------------------------ */

export function AgentPanel({
  agent,
  presets,
  personas,
  onSave,
  onDelete,
  onDuplicate,
  onPickDirectory,
  onClose,
}: {
  agent: AgentRecord;
  presets: PresetView[];
  personas: PersonaView[];
  onSave(patch: Partial<AgentRecord>): void;
  onDelete(): void;
  onDuplicate(): void;
  onPickDirectory(): Promise<string | null>;
  onClose(): void;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? '');
  const [persona, setPersona] = useState(agent.persona ?? '');
  const [presetId, setPresetId] = useState(agent.presetId ?? '');
  const [model, setModel] = useState(agent.model ?? '');
  const [workspaceRoot, setWorkspaceRoot] = useState(agent.workspaceRoot ?? '');
  const [policy, setPolicy] = useState<ApprovalPolicy | ''>(agent.approvalPolicy ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const preset = presets.find((p) => p.id === presetId);

  const save = () => {
    onSave({
      name: name.trim() || agent.name,
      description: description.trim() || undefined,
      persona: persona || undefined,
      presetId: presetId || undefined,
      model: model || undefined,
      workspaceRoot: workspaceRoot || undefined,
      approvalPolicy: (policy || undefined) as ApprovalPolicy | undefined,
    });
    onClose();
  };

  return (
    <Modal title={`Configure ${agent.name}`} onClose={onClose} wide>
      <section className="panel-section">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="field">
          <span>
            Instructions <em className="muted">— durable guidance applied to every message</em>
          </span>
          <textarea
            rows={5}
            value={description}
            placeholder="e.g. You review TypeScript for correctness and security. Always explain risky changes before making them."
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="field">
          <span>
            Persona <em className="muted">— used only when Instructions is empty</em>
          </span>
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="">Use the global default</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel-section">
        <h3>Overrides</h3>
        <p className="muted">Leave blank to inherit the global settings.</p>
        <div className="field-row">
          <label className="field">
            <span>Provider</span>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">Inherit</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              list="agent-model-options"
              value={model}
              placeholder="Inherit"
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="agent-model-options">
              {(preset?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>

        <label className="field">
          <span>Workspace folder</span>
          <div className="field-row">
            <input
              value={workspaceRoot}
              placeholder="Inherit"
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void onPickDirectory().then((d) => d && setWorkspaceRoot(d))}
            >
              Browse…
            </button>
          </div>
        </label>

        <label className="field">
          <span>Tool permissions</span>
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as ApprovalPolicy | '')}
          >
            <option value="">Inherit</option>
            <option value="ask">Ask every time</option>
            <option value="auto">Run without asking</option>
            <option value="readonly">Read-only</option>
          </select>
        </label>
      </section>

      <footer className="modal-foot modal-foot-split">
        <div>
          <button type="button" className="btn" onClick={onDuplicate}>
            Duplicate
          </button>
          {confirmDelete ? (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Really delete — this cannot be undone
            </button>
          ) : (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              Delete agent
            </button>
          )}
        </div>
        <div>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* MCP / Plugins                                                       */
/* ------------------------------------------------------------------ */

export function McpPanel({
  servers,
  configured,
  onAdd,
  onUpdate,
  onRemove,
  onClose,
}: {
  servers: McpServerStatus[];
  configured: McpServerRecord[];
  onAdd(server: McpServerRecord): Promise<boolean>;
  onUpdate(name: string, patch: Partial<McpServerRecord>): void;
  onRemove(name: string): void;
  onClose(): void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim() || !command.trim()) {
      setError('Name and command are both required.');
      return;
    }
    // Split on whitespace but honour simple quoted segments, so a Windows
    // path with spaces can be passed as one argument.
    const args = (argsText.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''));
    const ok = await onAdd({ name: name.trim(), command: command.trim(), args });
    if (ok) {
      setAdding(false);
      setName('');
      setCommand('');
      setArgsText('');
    }
  };

  return (
    <Modal title="Plugins (MCP servers)" onClose={onClose} wide>
      <p className="muted">
        MCP servers extend your agents with extra tools. They run as local processes on your
        machine; GhostBot spawns them with the command you provide.
      </p>

      <div className="list">
        {servers.length === 0 && !adding && (
          <p className="muted">No MCP servers configured yet.</p>
        )}
        {servers.map((s) => {
          const cfg = configured.find((c) => c.name === s.name);
          return (
            <div key={s.name} className="list-row">
              <div className="list-main">
                <div className="list-title">
                  <span className={`state-dot state-${s.state}`} />
                  {s.label || s.name}
                  <span className="muted"> — {s.state}</span>
                </div>
                {s.error && <div className="list-error">{s.error}</div>}
                {cfg && (
                  <div className="muted list-sub">
                    <code>
                      {cfg.command} {(cfg.args ?? []).join(' ')}
                    </code>
                  </div>
                )}
                {s.toolNames.length > 0 && (
                  <div className="chip-row">
                    {s.toolNames.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="list-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => onUpdate(s.name, { disabled: s.state !== 'disabled' })}
                >
                  {s.state === 'disabled' ? 'Enable' : 'Disable'}
                </button>
                <button type="button" className="btn btn-danger" onClick={() => onRemove(s.name)}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {adding ? (
        <section className="panel-section">
          <h3>Add a server</h3>
          <div className="field-row">
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                placeholder="filesystem"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Command</span>
              <input value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Arguments</span>
            <input
              value={argsText}
              placeholder="-y @modelcontextprotocol/server-filesystem C:\Users\me\projects"
              onChange={(e) => setArgsText(e.target.value)}
              spellCheck={false}
            />
          </label>
          {error && <p className="warn-inline">{error}</p>}
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submit()}>
              Add server
            </button>
          </div>
        </section>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Add MCP server
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Routines                                                            */
/* ------------------------------------------------------------------ */

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * 1' },
  { label: 'First of the month', cron: '0 9 1 * *' },
];

export function RoutinesPanel({
  routines,
  agents,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
  onClose,
}: {
  routines: RoutineRecord[];
  agents: AgentRecord[];
  onCreate(patch: Partial<RoutineRecord> & { agentId: string }): void;
  onUpdate(id: string, patch: Partial<RoutineRecord>): void;
  onDelete(id: string): void;
  onRunNow(id: string): void;
  onClose(): void;
}) {
  const [adding, setAdding] = useState(false);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');

  const submit = () => {
    if (!agentId || !prompt.trim()) return;
    onCreate({ agentId, name: name.trim() || 'Untitled routine', cron, prompt: prompt.trim(), enabled: true });
    setAdding(false);
    setName('');
    setPrompt('');
  };

  const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleString() : '—');

  return (
    <Modal title="Routines" onClose={onClose} wide>
      <p className="muted">
        Routines send a prompt to an agent on a schedule. Missed runs are not replayed — if the
        machine was asleep, the routine simply runs at its next scheduled time.
      </p>

      <div className="list">
        {routines.length === 0 && !adding && <p className="muted">No routines yet.</p>}
        {routines.map((r) => {
          const agent = agents.find((a) => a.id === r.agentId);
          const lastRun = r.runs?.[0];
          return (
            <div key={r.id} className="list-row">
              <div className="list-main">
                <div className="list-title">
                  {r.name}
                  <span className="muted"> — {agent?.name ?? 'deleted agent'}</span>
                </div>
                <div className="muted list-sub">
                  <code>{r.cron}</code> · next {fmt(r.nextRunAt)}
                  {lastRun && ` · last ${lastRun.status}`}
                </div>
                <div className="muted list-sub routine-prompt">{r.prompt.slice(0, 120)}</div>
                {lastRun?.summary && <div className="list-error">{lastRun.summary}</div>}
              </div>
              <div className="list-actions">
                <button type="button" className="btn" onClick={() => onRunNow(r.id)}>
                  Run now
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onUpdate(r.id, { enabled: !r.enabled })}
                >
                  {r.enabled ? 'Pause' : 'Enable'}
                </button>
                <button type="button" className="btn btn-danger" onClick={() => onDelete(r.id)}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {adding ? (
        <section className="panel-section">
          <h3>New routine</h3>
          <div className="field-row">
            <label className="field">
              <span>Agent</span>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} placeholder="Morning summary" onChange={(e) => setName(e.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>Schedule</span>
            <div className="field-row">
              <select
                value={CRON_PRESETS.some((p) => p.cron === cron) ? cron : 'custom'}
                onChange={(e) => e.target.value !== 'custom' && setCron(e.target.value)}
              >
                {CRON_PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                spellCheck={false}
                aria-label="Cron expression"
              />
            </div>
          </label>

          <label className="field">
            <span>Prompt</span>
            <textarea
              rows={3}
              value={prompt}
              placeholder="Summarize what changed in the repo since yesterday."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit}>
              Create routine
            </button>
          </div>
        </section>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAdding(true)}
            disabled={agents.length === 0}
          >
            New routine
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export function SkillsPanel({
  skills,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  skills: SkillRecord[];
  onCreate(patch: Partial<SkillRecord>): void;
  onUpdate(id: string, patch: Partial<SkillRecord>): void;
  onDelete(id: string): void;
  onClose(): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  const startNew = () => {
    setEditing('new');
    setName('');
    setDescription('');
    setBody('');
  };

  const startEdit = (s: SkillRecord) => {
    setEditing(s.id);
    setName(s.name);
    setDescription(s.description ?? '');
    setBody(s.body);
  };

  const submit = () => {
    if (!name.trim()) return;
    const patch = { name: name.trim(), description: description.trim() || undefined, body };
    if (editing === 'new') onCreate(patch);
    else if (editing) onUpdate(editing, patch);
    setEditing(null);
  };

  return (
    <Modal title="Skills" onClose={onClose} wide>
      <p className="muted">
        A skill is a reusable instruction set. Type <code>/name</code> in the composer to apply one.
      </p>

      {editing ? (
        <section className="panel-section">
          <div className="field-row">
            <label className="field">
              <span>Name (used as /name)</span>
              <input
                value={name}
                placeholder="changelog"
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={description}
                placeholder="Summarize commits into release notes"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Instructions (Markdown)</span>
            <textarea
              rows={10}
              value={body}
              placeholder={'Write release notes grouped by Added / Changed / Fixed.\nUse the imperative mood.'}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit}>
              Save skill
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="list">
            {skills.length === 0 && <p className="muted">No skills yet.</p>}
            {skills.map((s) => (
              <div key={s.id} className="list-row">
                <div className="list-main">
                  <div className="list-title">
                    /{s.name}
                    {!s.enabled && <span className="muted"> — disabled</span>}
                  </div>
                  {s.description && <div className="muted list-sub">{s.description}</div>}
                </div>
                <div className="list-actions">
                  <button type="button" className="btn" onClick={() => startEdit(s)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onUpdate(s.id, { enabled: !s.enabled })}
                  >
                    {s.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => onDelete(s.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={startNew}>
              New skill
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
