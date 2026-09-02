/**
 * Panels.tsx — the modal panels: Settings, Plugins (MCP), Routines, Skills,
 * and per-agent configuration.
 *
 * These are deliberately plain forms. The value of this app is the agent
 * loop and the provider freedom, not chrome; a settings screen that is
 * obvious beats one that is clever.
 */
// The explicit React import keeps these components renderable by toolchains
// that compile JSX with the classic runtime (the offline UI tests render them
// through react-dom/server outside the Vite build). It is a no-op under the
// automatic runtime Vite uses.
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useProviderModels } from './useProviderModels';
import { describeModelMismatch, isGroup } from '@wispcrew/shared';
import type {
  AgentRecord,
  ApprovalPolicy,
  GlobalSettings,
  McpServerRecord,
  ConversationRecord,
  HistoryPoint,
  McpServerStatus,
  NodeSummary,
  PersonaView,
  PresetView,
  RoutineRecord,
  DetectedSignIn,
  OAuthStatusView,
  SettingsView,
  SkillRecord,
  ToolGrant,
} from '@wispcrew/shared';

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
/* New agent                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create an agent: a name, a provider, and a model that provider serves.
 *
 * Only providers that actually have a key or sign-in are offered. Listing
 * every preset would let a user pick one they have not set up, producing a
 * failure at the agent's first message — and the reason (no key for *this*
 * provider) is not obvious when another provider is working fine.
 *
 * ## There is no "use the default"
 *
 * There used to be, and it was the first option. It made the common case one
 * click and it made a whole class of broken agent: the provider was left
 * inherited while the model was typed in, so the two came from different
 * places and nothing compared them. An OpenAI model on an inherited NVIDIA
 * provider is a request that returns `404 page not found` forever.
 *
 * Worse, the failure moved later. Changing the provider in Settings silently
 * changed where every "default" agent sent its requests, so an agent that
 * worked yesterday failed today with nothing about it having been edited.
 *
 * Provider and model are now one decision, made here, and both are required.
 */
function NewAgentPanel({
  presets,
  defaultPresetId,
  onCreate,
  onOpenSettings,
  onClose,
}: {
  presets: PresetView[];
  /** Which provider to preselect — a convenience, never a fallback. */
  defaultPresetId?: string;
  onCreate(patch: Partial<AgentRecord>): void;
  onOpenSettings(): void;
  onClose(): void;
}) {
  const configured = useMemo(() => presets.filter((p) => p.configured), [presets]);

  /*
   * Preselect a provider when there is an obvious one, so the common case is
   * still quick. This is a starting VALUE in a required field, not a
   * fallback: whatever is showing is what gets saved onto the agent.
   */
  const initialPreset =
    configured.find((p) => p.id === defaultPresetId)?.id ?? configured[0]?.id ?? '';

  const [name, setName] = useState('New agent');
  const [presetId, setPresetId] = useState(initialPreset);
  const [model, setModel] = useState(
    presets.find((p) => p.id === initialPreset)?.defaultModel ?? '',
  );

  const chosen = presets.find((p) => p.id === presetId);
  /*
   * Every model the provider reports, not only the six curated here.
   *
   * NVIDIA offers 84; the preset named six, so the field hid most of what
   * a key already paid for. Tested ones stay first.
   */
  const liveModels = useProviderModels(presetId, chosen?.models ?? []);

  /*
   * The same ownership rule the engine uses, applied while typing.
   *
   * The list is fetched from the provider, so picking from it is always
   * safe — but typing is deliberately still allowed, for a model released
   * this week or one a self-hosted endpoint serves. That leaves exactly one
   * way to name somebody else's model, and this is it.
   */
  const pairingProblem = describeModelMismatch(presets, presetId, model);
  const ready = Boolean(presetId) && model.trim().length > 0 && !pairingProblem;

  const create = () => {
    if (!ready) return;
    onCreate({
      name: name.trim() || 'New agent',
      presetId,
      model: model.trim(),
    });
    onClose();
  };

  return (
    <Modal title="New agent" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
      </label>

      <label className="field">
        <span>Provider</span>
        <select
          value={presetId}
          onChange={(e) => {
            const next = e.target.value;
            setPresetId(next);
            /*
             * Switching provider swaps in that provider's default model.
             *
             * Not cleared — an empty required field after every switch is a
             * chore — and above all not LEFT, which would carry the previous
             * vendor's model name onto the new provider. That is the exact
             * pairing this panel exists to make impossible.
             */
            setModel(presets.find((p) => p.id === next)?.defaultModel ?? '');
          }}
        >
          {configured.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {configured.length === 0 && (
        <p className="warn-inline">
          No providers are configured yet.{' '}
          <button type="button" className="link-button" onClick={onOpenSettings}>
            Open Settings
          </button>{' '}
          to add an API key or sign in.
        </p>
      )}

      {chosen && (
        <label className="field">
          <span>
            Model <em className="muted">— what this agent runs on</em>
          </span>
          {/*
            A combo box, not a closed list. The catalogue is fetched live, so
            it is normally right — but a model released this week, or one a
            self-hosted endpoint serves under its own name, must still be
            usable without waiting for a release of this app.
          */}
          <input
            list="new-agent-models"
            value={model}
            placeholder={chosen.defaultModel}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="new-agent-models">
              {liveModels.map((m) => (
                <option key={m.id} value={m.id} label={m.tested ? 'verified with tools' : undefined} />
              ))}
          </datalist>
          <span className="muted small">
            Belongs to this agent. Changing the provider in Settings will not move it.
          </span>
        </label>
      )}

      {pairingProblem && <p className="warn-inline">{pairingProblem}</p>}

      <div className="row-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={create}
          disabled={!ready}
          title={ready ? undefined : (pairingProblem ?? 'Choose a provider and a model')}
        >
          Create agent
        </button>
      </div>
    </Modal>
  );
}

export { NewAgentPanel };

/* ------------------------------------------------------------------ */
/* New: an agent, or a group                                           */
/* ------------------------------------------------------------------ */

/**
 * The plus button asks what you are making.
 *
 * It always made an agent, which was fine while a room was an agent. Now
 * that a group is a thing in its own right, the button that creates things
 * has to offer it — a feature reachable only from a menu nobody opens is a
 * feature that does not exist.
 *
 * Two choices, each with the sentence that tells them apart. "Agent" and
 * "Group" alone would be a guess on a first run, and this is the screen
 * where a new user meets the distinction the whole app rests on.
 */
export function NewChoicePanel({
  canGroup,
  onAgent,
  onGroup,
  onClose,
}: {
  /** False with fewer than two agents — a group of one is not a group. */
  canGroup: boolean;
  onAgent(): void;
  onGroup(): void;
  onClose(): void;
}) {
  return (
    <Modal title="What would you like to create?" onClose={onClose}>
      <button type="button" className="choice-card" onClick={onAgent}>
        <strong>An agent</strong>
        <span className="muted">
          A teammate with its own instructions, model and workspace. You talk to it
          privately.
        </span>
      </button>

      {/*
        Disabled rather than hidden when there is only one agent.
        
        Hiding it would leave a new user unable to discover that groups
        exist at all; disabling it with the reason attached teaches the rule
        at the moment it applies.
      */}
      <button
        type="button"
        className="choice-card"
        onClick={onGroup}
        disabled={!canGroup}
        title={canGroup ? undefined : 'A group needs at least two agents'}
      >
        <strong>A group</strong>
        <span className="muted">
          {canGroup
            ? 'A place where agents you have already configured talk together. It has no model of its own — everyone brings their own.'
            : 'Needs at least two agents. Create another one first.'}
        </span>
      </button>
    </Modal>
  );
}

/**
 * Set up a group: a name, what it is for, and who is in it.
 *
 * There is no provider and no model field, and that absence is the design
 * rather than an omission. A room does not reconfigure the agents in it;
 * they arrive configured, and a room that could change that would make the
 * same agent answer differently depending on where it was spoken to.
 */
export function NewGroupPanel({
  agents,
  nodes,
  onCreate,
  onClose,
}: {
  agents: AgentRecord[];
  /** Paired machines, so a member's home can be named rather than guessed. */
  nodes: NodeSummary[];
  onCreate(patch: { title: string; agentIds: string[]; greeting?: string }): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState('');
  const [greeting, setGreeting] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);

  const live = useMemo(() => agents.filter((a) => !a.archived), [agents]);

  /*
   * Everyone in a room must live on the same machine.
   *
   * A room's transcript lives on one node, and an agent's conversation,
   * files and keys live on its own. A room spanning two machines would need
   * the transcript replicated, which is a distributed-systems feature, not
   * a checkbox — so rather than let somebody build a room that half works,
   * the first choice fixes the machine and the rest are disabled with the
   * reason attached.
   */
  const homeOf = (a: AgentRecord) => a.nodeId ?? '';
  const home = chosen.length ? homeOf(live.find((a) => a.id === chosen[0])!) : null;
  const machineName = (id: string) =>
    id ? (nodes.find((n) => n.id === id)?.name ?? 'another machine') : 'this computer';

  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  const ready = title.trim().length > 0 && chosen.length >= 2;

  return (
    <Modal title="New group" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input
          value={title}
          autoFocus
          placeholder="e.g. Deploy review"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="field">
        <span>
          Room instructions <em className="muted">— optional</em>
        </span>
        <textarea
          rows={3}
          value={greeting}
          placeholder="What is this room for, and in what tone? Everyone here will read it."
          onChange={(e) => setGreeting(e.target.value)}
        />
      </label>
      {/*
        Said at the moment it is written, not only in the room afterwards.
        Somebody typing standing instructions is entitled to know they are
        not a private directive before they type them.
      */}
      <p className="muted small">
        Visible to everyone in the room, including the agents. They are told to follow it,
        to say what it is if asked, and to speak up if something in it is wrong.
      </p>

      <h3>Who is in it</h3>
      <p className="muted small">
        At least two. Each keeps its own model, instructions and workspace — a group does
        not change how any of them are configured.
      </p>

      <div className="node-list">
        {live.map((a) => {
          const blocked = home !== null && homeOf(a) !== home && !chosen.includes(a.id);
          return (
            <label
              key={a.id}
              className={`field checkbox-field${blocked ? ' checkbox-blocked' : ''}`}
              title={
                blocked
                  ? `Everyone in a room must run on the same machine. This group is on ${machineName(home)}.`
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={chosen.includes(a.id)}
                disabled={blocked}
                onChange={() => toggle(a.id)}
              />
              <span>
                {a.name}
                {a.nodeId && (
                  <em className="muted"> — on {machineName(a.nodeId)}</em>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="row-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          title={ready ? undefined : 'A group needs a name and at least two agents'}
          onClick={() => {
            onCreate({
              title: title.trim(),
              agentIds: chosen,
              greeting: greeting.trim() || undefined,
            });
            onClose();
          }}
        >
          Create group
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Subscription sign-in                                                */
/* ------------------------------------------------------------------ */

/**
 * Sign in with a Claude or ChatGPT subscription instead of an API key.
 *
 * The warning is shown **before** the button, not tucked underneath it. This
 * option can cost a user their subscription — Anthropic prohibits
 * third-party tools from using Claude subscription tokens — so burying that
 * where it reads as boilerplate would be dishonest. An API key is the
 * supported path and the UI says so.
 */
function SubscriptionSignIn({
  vendor,
  statuses,
  detected,
  onSignIn,
  onSignOut,
  onImport,
}: {
  vendor: 'anthropic' | 'chatgpt';
  statuses: OAuthStatusView[];
  detected: DetectedSignIn[];
  onSignIn(vendor: 'anthropic' | 'chatgpt'): Promise<string | null>;
  onSignOut(vendor: 'anthropic' | 'chatgpt'): void;
  onImport(vendor: 'anthropic' | 'chatgpt'): Promise<string | null>;
}) {
  const [busy, setBusy] = useState<'signin' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = statuses.find((s) => s.vendor === vendor);
  const cli = detected.find((d) => d.vendor === vendor);
  const vendorName = vendor === 'chatgpt' ? 'ChatGPT' : 'Claude';

  const run = async (kind: 'signin' | 'import') => {
    setBusy(kind);
    setError(null);
    const message = await (kind === 'signin' ? onSignIn(vendor) : onImport(vendor));
    if (message) setError(message);
    setBusy(null);
  };

  return (
    <section className="signin-block">
      <p className="warn-inline signin-warning">
        <strong>Uses your {vendorName} subscription instead of an API key.</strong>{' '}
        {vendor === 'anthropic'
          ? 'Anthropic prohibits third-party tools from using Claude subscription tokens and may suspend accounts without warning.'
          : 'OpenAI does not document this for third-party apps, and the endpoint it uses is private and can change at any time.'}{' '}
        An API key is the supported option.
      </p>

      {status?.signedIn ? (
        <>
          <div className="signin-state">
            <span className="state-dot state-connected" />
            <span>
              Signed in to {vendorName}
              {status.plan ? ` (${status.plan} plan)` : ''}
              {status.expiresAt ? <span className="muted"> · renews automatically</span> : null}
            </span>
            <button type="button" className="btn" onClick={() => onSignOut(vendor)}>
              Sign out
            </button>
          </div>

          {/*
            Quota, when the provider reports it. There is no usage endpoint to
            query, so this appears only after a turn has been run — saying
            that plainly is better than showing a stale or invented figure.
          */}
          {status.usage ? (
            <div className="usage-block">
              {status.usage.percentUsed !== undefined && (
                <div
                  className="usage-bar"
                  role="progressbar"
                  aria-valuenow={Math.round(status.usage.percentUsed)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${vendorName} plan usage`}
                >
                  <div
                    className={`usage-fill${status.usage.percentUsed >= 90 ? ' usage-high' : ''}`}
                    style={{ width: `${Math.min(100, Math.max(0, status.usage.percentUsed))}%` }}
                  />
                </div>
              )}
              <p className="muted usage-text">{status.usage.summary}</p>
            </div>
          ) : (
            <p className="muted usage-text">
              Usage appears here after your first message — the provider only
              reports it with a response.
            </p>
          )}
        </>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void run('signin')}
            disabled={busy !== null}
          >
            {busy === 'signin' ? 'Waiting for your browser…' : `Sign in with ${vendorName}`}
          </button>
          {/* Adopting an existing CLI sign-in skips the browser entirely,
              which is quicker when the user already has one. */}
          {cli?.available && (
            <button
              type="button"
              className="btn"
              onClick={() => void run('import')}
              disabled={busy !== null}
              title={cli.detail}
            >
              {busy === 'import' ? 'Importing…' : `Use ${cli.source} sign-in`}
            </button>
          )}
        </div>
      )}

      {!status?.signedIn && cli && !cli.available && (
        <p className="muted signin-hint">{cli.detail}</p>
      )}
      {error && <p className="warn-inline">{error}</p>}
    </section>
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
  /** Subscription sign-in state and actions. */
  oauthStatuses: OAuthStatusView[];
  detectedSignIns: DetectedSignIn[];
  /** Return an error message, or null on success. */
  onOAuthSignIn(vendor: 'anthropic' | 'chatgpt'): Promise<string | null>;
  onOAuthImport(vendor: 'anthropic' | 'chatgpt'): Promise<string | null>;
  onOAuthSignOut(vendor: 'anthropic' | 'chatgpt'): void;
  onSave(patch: Partial<GlobalSettings> & { apiKey?: string }): Promise<unknown>;
  onTest(cfg: {
    presetId: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): Promise<{ ok: boolean; error?: string; latencyMs?: number }>;
  onPickDirectory(): Promise<string | null>;
  /** Send a real Telegram message, so a wrong chat id is caught at setup. */
  onTestTelegram(): Promise<{ ok: boolean; error?: string }>;
  /** Read the chat id from a bot the user has already messaged. */
  onDiscoverChatId(): Promise<string | null>;
  onClose(): void;
}

/**
 * Settings groups.
 *
 * Ordered by how often they are needed: the provider must work before
 * anything else does; appearance is set once and forgotten.
 */
const SETTINGS_TABS = [
  { id: 'provider', label: 'Provider' },
  { id: 'agents', label: 'Agent defaults' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'channels', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

/**
 * Where agents may reach the user.
 *
 * Its own tab because it is the one setting that sends something off the
 * machine, and that deserves room to explain itself rather than a checkbox
 * among provider fields.
 */
function ChannelsSection({
  settings,
  onSave,
  onTestTelegram,
  onDiscoverChatId,
}: {
  settings: SettingsView;
  onSave: (patch: Partial<GlobalSettings> & { telegramToken?: string }) => void;
  onTestTelegram: () => Promise<{ ok: boolean; error?: string }>;
  onDiscoverChatId: () => Promise<string | null>;
}) {
  const [enabled, setEnabled] = useState<string[]>(settings.channels?.enabled ?? []);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState(settings.channels?.telegram?.chatId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const telegramReady = Boolean(settings.channels?.telegram?.configured);

  const toggle = (id: string) => {
    const next = enabled.includes(id) ? enabled.filter((c) => c !== id) : [...enabled, id];
    setEnabled(next);
    onSave({ channels: { ...settings.channels, enabled: next as never } });
  };

  return (
    <section className="panel-section">
      <h3>How agents reach you</h3>
      <p className="muted small">
        An agent working on a schedule can tell you what it found. Choose where it may do
        that. Whatever it sends is written to the conversation as well.
      </p>

      <label className="field checkbox-field">
        <input type="checkbox" checked disabled />
        <span>
          The conversation <em className="muted">— always on, seen when you next look</em>
        </span>
      </label>

      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={enabled.includes('desktop')}
          onChange={() => toggle('desktop')}
        />
        <span>
          Desktop notification <em className="muted">— appears while the app is open</em>
        </span>
      </label>

      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={enabled.includes('telegram')}
          onChange={() => toggle('telegram')}
          disabled={!telegramReady}
        />
        <span>
          Telegram{' '}
          <em className="muted">
            {telegramReady
              ? '— a direct message, even with the app closed'
              : '— set up below to enable'}
          </em>
        </span>
      </label>

      <h3>Telegram</h3>
      <p className="muted small">
        The only channel that reaches you away from this computer. You create the bot, so
        nothing passes through a WispCrew service and only your own agents can write to it.
      </p>
      <ol className="muted small steps">
        <li>
          Message <code>@BotFather</code> on Telegram and send <code>/newbot</code>.
        </li>
        <li>Paste the token it gives you below and press Save.</li>
        <li>Send your new bot any message, then press Find my chat.</li>
      </ol>

      <label className="field">
        <span>
          Bot token
          {telegramReady && <em className="muted"> — saved; enter a new one to replace it</em>}
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={telegramReady ? 'saved' : '123456:ABC-DEF...'}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>Chat</span>
        <input
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="Press Find my chat after messaging your bot"
          spellCheck={false}
        />
      </label>

      {result && <p className={result.ok ? 'muted small' : 'list-error'}>{result.text}</p>}

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => {
            onSave({
              channels: { ...settings.channels, telegram: { configured: true, chatId } },
              telegramToken: token || undefined,
            });
            setToken('');
            setResult({ ok: true, text: 'Saved.' });
          }}
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            setBusy('discover');
            setResult(null);
            void onDiscoverChatId().then((found) => {
              setBusy(null);
              if (found) {
                setChatId(found);
                setResult({ ok: true, text: 'Found your chat. Press Save to keep it.' });
              } else {
                setResult({
                  ok: false,
                  text: 'No message found. Send your bot something first, then try again.',
                });
              }
            });
          }}
        >
          {busy === 'discover' ? 'Looking...' : 'Find my chat'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !telegramReady}
          onClick={() => {
            setBusy('test');
            setResult(null);
            void onTestTelegram().then((r) => {
              setBusy(null);
              setResult(
                r.ok
                  ? { ok: true, text: 'Sent. Check Telegram.' }
                  : { ok: false, text: r.error ?? 'Could not send.' },
              );
            });
          }}
        >
          {busy === 'test' ? 'Sending...' : 'Send a test'}
        </button>
      </div>
    </section>
  );
}

export function SettingsPanel({
  settings,
  presets,
  personas,
  grants,
  agentName,
  onRevokeGrant,
  onRevokeAllGrants,
  oauthStatuses,
  detectedSignIns,
  onOAuthSignIn,
  onOAuthImport,
  onOAuthSignOut,
  onSave,
  onTest,
  onPickDirectory,
  onTestTelegram,
  onDiscoverChatId,
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>('provider');
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
  /* Every model the provider reports, not only the curated few. */
  const liveModels = useProviderModels(presetId, preset?.models ?? []);

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

        {/*
          Grouped rather than one long scroll.

          The panel had reached 327 lines covering provider setup, agent
          defaults, permissions and appearance; notifications would have made
          it worse. The sections already existed, so this only groups them.
        */}
        <div className="tabs" role="tablist">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'provider' && <div className="tab-panel">
      <section className="panel-section">
        <h3>Credentials</h3>
        {/*
          This tab sets up ACCESS, not defaults.
          
          It used to double as "the provider and model new agents inherit",
          and that second job is gone: an agent carries its own provider and
          model, so nothing here can move an existing one. Saying so removes
          the reasonable fear that changing a key here will change what an
          agent runs on.
        */}
        <p className="muted">
          Keys and sign-ins live here, one per provider. Each agent picks its own
          provider and model — nothing on this screen changes an agent that already
          exists.
        </p>
        <div className="provider-grid">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`provider-card ${p.id === presetId ? 'selected' : ''} ${
                p.configured ? 'configured' : ''
              }`}
              onClick={() => choosePreset(p.id)}
              // Several providers can be set up at once, so the card says
              // whether *this* one is ready rather than only which is
              // selected. Without it there is no way to see what you have
              // already configured.
              aria-label={`${p.label}${p.configured ? ', configured' : ', not configured'}`}
            >
              <span className="provider-name">
                {p.label}
                {p.configured && (
                  <span className="provider-check" aria-hidden="true" title="Configured">
                    ✓
                  </span>
                )}
              </span>
              <span className="provider-kind">
                {p.local ? 'local' : p.subscription ? 'subscription' : 'cloud'}
              </span>
            </button>
          ))}
        </div>

        {preset?.subscription ? (
          <SubscriptionSignIn
            vendor={preset.id === 'chatgpt-subscription' ? 'chatgpt' : 'anthropic'}
            statuses={oauthStatuses}
            detected={detectedSignIns}
            onSignIn={onOAuthSignIn}
            onSignOut={onOAuthSignOut}
            onImport={onOAuthImport}
          />
        ) : (
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
              placeholder={
                preset?.local ? 'Not required for local endpoints' : (preset?.keyHint ?? '')
              }
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        {!settings.isEncrypted && (
          <p className="warn-inline">
            This system reports no OS keychain, so keys are stored in a permission-restricted
            plaintext file rather than encrypted.
          </p>
        )}

        <div className="field-row">
          <label className="field">
            {/*
              This model is for TESTING the credential, and says so.
              
              It was the default every agent inherited. The label mattered
              more than it looked: somebody setting up a key would change it
              to try something, and silently move every agent that had left
              its own model blank.
            */}
            <span>
              Model <em className="muted">— used by Test connection only</em>
            </span>
            <input
              list="model-options"
              value={model}
              placeholder={preset?.defaultModel}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
            <datalist id="model-options">
              {liveModels.map((m) => (
                <option key={m.id} value={m.id} label={m.tested ? 'verified with tools' : undefined} />
              ))}
            </datalist>
          </label>
          {/* A subscription endpoint is fixed by the sign-in; offering to
              edit it would only let the user break their own setup. */}
          {!preset?.subscription && (
            <label className="field">
              <span>Base URL</span>
              <input
                value={baseUrl}
                placeholder={preset?.baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                spellCheck={false}
              />
            </label>
          )}

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
      <footer className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
        </div>}

        {tab === 'agents' && <div className="tab-panel">
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
        </div>}

        {tab === 'permissions' && <div className="tab-panel">
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
        </div>}

        {tab === 'channels' && <div className="tab-panel">
          <ChannelsSection
            settings={settings}
            onSave={onSave}
            onTestTelegram={onTestTelegram}
            onDiscoverChatId={onDiscoverChatId}
          />
        </div>}

        {tab === 'appearance' && <div className="tab-panel">
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
        </div>}

    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Agent configuration                                                 */
/* ------------------------------------------------------------------ */

/**
 * Channels a user can choose per agent.
 *
 * The conversation is deliberately absent: it is always on and needs no
 * permission, so offering it as a checkbox would imply it can be switched
 * off.
 */
const CHANNEL_CHOICES = [
  { id: 'desktop', label: 'Desktop notification' },
  { id: 'telegram', label: 'Telegram' },
] as const;

export function AgentPanel({
  agent,
  presets,
  personas,
  nodes,
  globalPolicy,
  onSave,
  onDelete,
  onDuplicate,
  onPickDirectory,
  onClose,
}: {
  agent: AgentRecord;
  presets: PresetView[];
  personas: PersonaView[];
  /** The global default, so an inherited policy can be named rather than guessed. */
  globalPolicy?: ApprovalPolicy;
  /** Paired machines; empty when everything runs locally. */
  nodes: NodeSummary[];
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
  const [baseUrl, setBaseUrl] = useState(agent.baseUrl ?? '');
  const [nodeId, setNodeId] = useState(agent.nodeId ?? '');
  const [workspaceRoot, setWorkspaceRoot] = useState(agent.workspaceRoot ?? '');

  /*
   * What the machine this agent runs on can actually use.
   *
   * `null` means "asked and could not reach it", which is different from
   * "not asked yet" — the first deserves a warning, the second does not.
   */
  const [remotePresets, setRemotePresets] = useState<PresetView[] | null | undefined>(undefined);

  useEffect(() => {
    if (!nodeId) {
      setRemotePresets(undefined);
      return;
    }
    let cancelled = false;
    void window.wispcrew.presetsForNode(nodeId).then((list) => {
      if (!cancelled) setRemotePresets(list);
    });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  /*
   * Fall back to this machine's list when the other one cannot be reached,
   * and say so beside the field — an empty list would look like a broken
   * panel rather than a disconnected machine.
   */
  const shownPresets = nodeId && remotePresets ? remotePresets : presets;
  const nodeName = nodes.find((n) => n.id === nodeId)?.name;
  const [policy, setPolicy] = useState<ApprovalPolicy | ''>(agent.approvalPolicy ?? '');
  /*
   * undefined means "follow the global setting"; an array overrides it,
   * including an empty one, which is how an agent is told to stay silent.
   */
  const [agentChannels, setAgentChannels] = useState<string[] | undefined>(agent.channels);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /*
   * What this agent may do when the request arrived from Telegram.
   *
   * Empty means "follow the rule": inherit the agent's own policy, except
   * that `auto` is reduced to `ask`, because a chat anyone could compromise
   * is not the same as the keyboard in front of you. An explicit value here
   * overrides that in either direction — which is how a user grants full
   * remote autonomy deliberately rather than drifting into it.
   */
  const [telegramPolicy, setTelegramPolicy] = useState<ApprovalPolicy | ''>(
    agent.channelPolicies?.telegram ?? '',
  );

  /** What "same as above" actually resolves to, for honest labelling. */
  const effectivePolicy = policy || globalPolicy || 'ask';

  const preset = shownPresets.find((p) => p.id === presetId);
  /* Every model the provider reports, not only the curated few. */
  const liveModels = useProviderModels(presetId, preset?.models ?? []);

  /*
   * A provider and a model, or no save.
   *
   * The two are one decision, so the button is what enforces it: an agent
   * that cannot work should not be saveable. Everything else on this panel
   * may still be left blank, because a workspace or a policy falling back to
   * a sensible default cannot point a request at the wrong company.
   */
  const canSave = Boolean(presetId) && model.trim().length > 0;

  /*
   * The same rule the engine applies before a turn, applied while typing.
   *
   * Imported from `shared` rather than reimplemented: it judges ownership
   * rather than absence, which is subtle enough that a second copy would
   * eventually disagree — and disagreeing here means the panel blesses a
   * pairing the engine then refuses, or the reverse.
   *
   * Judged against the list for the machine this agent RUNS ON, which for a
   * remote agent is not this one's.
   */
  const pairingProblem = describeModelMismatch(shownPresets, presetId, model);

  /*
   * A pairing another vendor owns cannot be saved.
   *
   * Not merely warned about. A warning above a working Save button is how
   * this agent got into that state in the first place — and the cost of
   * being wrong lands later, in whatever room it was added to, on somebody
   * else's tokens.
   */
  const saveable = canSave && !pairingProblem;

  const save = () => {
    if (!saveable) return;
    onSave({
      name: name.trim() || agent.name,
      description: description.trim() || undefined,
      persona: persona || undefined,
      presetId,
      model: model.trim(),
      baseUrl: baseUrl.trim() || undefined,
      // Empty means this computer. `undefined` deletes the field, which is
      // what "runs here" has always looked like on disk.
      nodeId: nodeId || undefined,
      workspaceRoot: workspaceRoot || undefined,
      approvalPolicy: (policy || undefined) as ApprovalPolicy | undefined,
      /*
       * An explicit `undefined` DELETES the override.
       *
       * Storing an empty string would resolve to nothing at read time and
       * silently pin the agent to a fallback — the bug class the settings
       * writer already guards against.
       */
      // Naming it in `clear` is what actually removes it: an explicit
      // `undefined` is dropped in transit and the old value survives.
      ...(telegramPolicy
        ? { channelPolicies: { telegram: telegramPolicy as ApprovalPolicy } }
        : { clear: ['channelPolicies'] }),
      channels: agentChannels as never,
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
        <h3>Model</h3>
        {/*
          Not "Overrides" any more, and nothing here inherits.
          
          Provider and model used to be blank-means-inherit. They fell back
          INDEPENDENTLY, which is what made it dangerous: the model was
          usually set and the provider usually was not, so an OpenAI model
          ended up aimed at NVIDIA — `404 page not found`, forever. And the
          failure could arrive later, without this agent being touched,
          because changing the provider in Settings moved every agent that
          had left it blank.
        */}
        <p className="muted">
          This agent's own. Changing anything in Settings will not move it.
        </p>
        <div className="field-row">
          <label className="field">
            <span>Provider</span>
            <select
              value={presetId}
              onChange={(e) => {
                const next = e.target.value;
                setPresetId(next);
                /*
                 * The model follows the provider.
                 *
                 * Leaving it would carry the previous vendor's model name
                 * onto the new provider — the precise mismatch this panel
                 * now exists to prevent, produced by the act of fixing it.
                 */
                setModel(shownPresets.find((p) => p.id === next)?.defaultModel ?? '');
              }}
            >
              {/*
                Marking unconfigured providers matters: picking one with no
                key fails at the first message, and the reason — a key was
                never entered for *this* provider — is not obvious when
                another provider works fine.

                For an agent on another machine, "configured" has to mean
                configured THERE. Showing this machine's list let a ChatGPT
                subscription model be chosen for a VPS that has only Ollama
                and an NVIDIA key: valid-looking, saveable, and unusable.
              */}
              {shownPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.configured ? '' : ' — not configured'}
                </option>
              ))}
            </select>
            {nodeId && (
              <span className="hint small">
                {remotePresets === null
                  ? 'That machine is not connected — this is your own list, which may not match it.'
                  : `As configured on ${nodeName ?? 'that machine'}.`}
              </span>
            )}
          </label>
          <label className="field">
            <span>Model</span>
            {/*
              A combo box, not a closed list. The catalogue is fetched from
              the provider so it is normally right — but a model released
              this week, or one a self-hosted endpoint serves under its own
              name, must stay usable without a release of this app.
            */}
            <input
              list="agent-model-options"
              value={model}
              placeholder={preset?.defaultModel ?? 'Choose a provider first'}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="agent-model-options">
              {liveModels.map((m) => (
                <option key={m.id} value={m.id} label={m.tested ? 'verified with tools' : undefined} />
              ))}
            </datalist>
          </label>
        </div>

        {preset && !preset.configured && (
          <p className="warn-inline">
            {preset.label} has no {preset.subscription ? 'sign-in' : 'API key'} yet. Add one in
            Settings, or this agent will fail on its first message.
          </p>
        )}

        {/*
          A model another vendor owns, caught before it is saved.
          
          Typing is deliberately still allowed — a model newer than this app
          has to be reachable — so this is the one remaining way to produce a
          pairing that cannot work. Saying so here, beside the field, beats
          finding out when the agent next speaks.
        */}
        {pairingProblem && <p className="warn-inline">{pairingProblem}</p>}

        {/* Only useful for a self-hosted or proxied endpoint, so it is not
            given prominence — but without it, an agent on a different
            provider had no way to reach a non-default host. */}
        {presetId && !preset?.subscription && (
          <label className="field">
            <span>
              Base URL <em className="muted">— optional, for self-hosted or proxied endpoints</em>
            </span>
            <input
              value={baseUrl}
              placeholder={preset?.baseUrl ?? 'Provider default'}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
          </label>
        )}

        {/*
          Only offered once a machine is paired. A picker with one option is
          noise, and the idea is easier to meet at the moment it becomes real
          than as a permanent field nobody uses.
        */}
        {nodes.length > 0 && (
          <label className="field">
            <span>
              Runs on <em className="muted">— which machine does this agent's work</em>
            </span>
            <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
              <option value="">This computer</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                  {node.connected ? '' : ' (not reachable)'}
                </option>
              ))}
            </select>
            <span className="muted small">
              This agent's conversation, files and provider keys live on the machine it runs
              on. Changing it starts fresh there rather than moving anything across.
            </span>
          </label>
        )}

        {/*
          An agent may warrant more or less noise than the default: a
          monitoring agent might deserve a message on your phone, while a
          scratch agent should stay in the app.

          Three states, not two, so this cannot be a plain checkbox list —
          "follow the global setting" is different from "no channels", and
          the latter is a real choice for an agent that should stay quiet.
        */}
        <label className="field">
          <span>
            Notifications <em className="muted">— where this agent may reach you</em>
          </span>
          <select
            value={agentChannels === undefined ? 'default' : 'custom'}
            onChange={(e) => setAgentChannels(e.target.value === 'default' ? undefined : [])}
          >
            <option value="">Use the global setting</option>
            <option value="custom">Choose for this agent</option>
          </select>
        </label>

        {agentChannels !== undefined && (
          <>
            {CHANNEL_CHOICES.map((choice) => (
              <label key={choice.id} className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={agentChannels.includes(choice.id)}
                  onChange={() =>
                    setAgentChannels(
                      agentChannels.includes(choice.id)
                        ? agentChannels.filter((c) => c !== choice.id)
                        : [...agentChannels, choice.id],
                    )
                  }
                />
                <span>{choice.label}</span>
              </label>
            ))}
            {agentChannels.length === 0 && (
              <p className="muted small">This agent will only write to the conversation.</p>
            )}
          </>
        )}

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

        {/*
          Telegram is a different risk from the keyboard in front of you.

          Anyone who can reach the chat can instruct this agent, so an
          inherited `auto` is reduced to `ask` for requests arriving there.
          Saying so here is what makes the behaviour explicable: otherwise an
          agent set to run unattended starts asking for approval and nothing
          in the interface explains why.
        */}
        <label className="field">
          <span>When asked from Telegram</span>
          <select
            value={telegramPolicy}
            onChange={(e) => setTelegramPolicy(e.target.value as ApprovalPolicy | '')}
          >
            <option value="">
              {effectivePolicy === 'auto' ? 'Ask first (safer than here)' : 'Same as above'}
            </option>
            <option value="ask">Ask every time</option>
            <option value="auto">Run without asking</option>
            <option value="readonly">Read-only</option>
          </select>
        </label>
        <p className={telegramPolicy === 'auto' ? 'warn-inline' : 'muted small'}>
          {telegramPolicy === 'auto'
            ? 'Anyone who can message your bot will be able to make this agent run shell commands.'
            : effectivePolicy === 'auto'
              ? 'This agent runs unattended at this machine, but a request from your phone still asks first.'
              : 'A remote request never gets more permission than it would here.'}
        </p>
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
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={!saveable}
            title={
              saveable
                ? undefined
                : (pairingProblem ?? 'This agent needs a provider and a model')
            }
          >
            Save
          </button>
        </div>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Room — who is in this conversation                                  */
/* ------------------------------------------------------------------ */

/**
 * Members of a room.
 *
 * Phrased around what the user is deciding rather than the data model:
 * "who can answer here", not "participant collection". Removing an agent
 * says what is and is not lost, because that is the question someone
 * actually has at that moment.
 */
export function RoomPanel({
  room,
  agents,
  onAdd,
  onSplit,
  onRemove,
  onSetMode,
  onDelete,
  onClose,
}: {
  room: ConversationRecord;
  agents: AgentRecord[];
  onAdd: (agentId: string) => void;
  /**
   * Turn a one-to-one into a group, with or without what has been said.
   *
   * Separate from `onAdd` because it is a different act: it creates a NEW
   * conversation rather than changing the one you are in.
   */
  onSplit: (agentId: string, bringHistory: boolean) => void;
  onRemove: (participantId: string) => void;
  onSetMode: (mode: string) => void;
  /** Remove the whole room. Groups only — see the footer. */
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inRoom = room.participants.filter((p) => p.kind === 'agent');
  const available = agents.filter((a) => !inRoom.some((p) => p.id === a.id));
  const group = isGroup(room);

  /*
   * The agent chosen for a one-to-one, waiting on the question.
   *
   * Adding a second agent used to convert the chat in place, and the
   * newcomer arrived with no idea what had been discussed. Neither answer
   * is right for every case — starting fresh keeps a private conversation
   * private; bringing the history is what lets the joining agent see where
   * things stand — so it is a question rather than a default.
   */
  const [joining, setJoining] = useState<AgentRecord | null>(null);

  if (joining && !group) {
    return (
      <Modal title={`Add ${joining.name} to this conversation`} onClose={() => setJoining(null)}>
        <p className="muted">
          This chat is between you and {inRoom.length === 1 ? room.title : 'one agent'}. Adding
          someone makes a group, and the chat you are in now stays exactly as it is.
        </p>

        <button
          type="button"
          className="choice-card"
          onClick={() => {
            onSplit(joining.id, true);
            onClose();
          }}
        >
          <strong>Bring the history</strong>
          <span className="muted">
            The group starts with everything said so far, so {joining.name} can see where
            things stand. It will be able to read the whole conversation.
          </span>
        </button>

        <button
          type="button"
          className="choice-card"
          onClick={() => {
            onSplit(joining.id, false);
            onClose();
          }}
        >
          <strong>Start fresh</strong>
          <span className="muted">
            An empty group with the two of them. Nothing already said is shared.
          </span>
        </button>

        <div className="row-actions">
          <button type="button" className="btn" onClick={() => setJoining(null)}>
            Cancel
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Who is in "${room.title}"`} onClose={onClose} wide>
      <p className="muted">
        Everyone here sees every message. Who <em>answers</em> depends on how you address
        them: tag an agent with its handle, use <code>@all</code> for the room, or just
        keep typing to continue with whoever you last addressed.
      </p>

      <h3>Agents</h3>
      <div className="node-list">
        {inRoom.map((p) => {
          const handle = (p as { handle: string }).handle;
          const record = agents.find((a) => a.id === p.id);
          const invited = (p as { invitedBy?: string }).invitedBy;

          return (
            <div key={p.id} className="node-row">
              <div className="node-main">
                <strong>@{handle}</strong>
                <span className="muted"> — {record?.name ?? 'deleted agent'}</span>
              </div>
              <div className="muted small">
                {invited ? 'Invited for this conversation' : 'Added by you'}
              </div>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onRemove(p.id)}
                disabled={inRoom.length <= 1}
                title={
                  inRoom.length <= 1
                    ? 'A conversation needs at least one agent'
                    : 'Remove from this conversation'
                }
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      {available.length > 0 && (
        <>
          <h3>Add an agent</h3>
          <p className="muted small">
            {group
              ? 'Its conversation elsewhere is unaffected — an agent can be in several rooms.'
              : 'This is a private chat, so adding someone starts a group. You will be asked whether to bring the history across.'}
          </p>
          <div className="row-actions">
            {available.map((a) => (
              <button
                key={a.id}
                type="button"
                className="btn"
                onClick={() => (group ? onAdd(a.id) : setJoining(a))}
              >
                + {a.name}
              </button>
            ))}
          </div>
        </>
      )}

      <h3>Who may speak</h3>
      <label className="field">
        <span>Mode</span>
        <select value={room.mode} onChange={(e) => onSetMode(e.target.value)}>
          <option value="directed">Directed — only agents you tag</option>
          <option value="open">Open — untagged agents may offer to answer</option>
          <option value="free">Free — any agent may answer</option>
        </select>
      </label>
      <p className="muted small">
        Agents never reply to each other unless addressed, in any mode, and a run of agent
        turns stops to check with you before it can get away from itself.
      </p>

      {/*
        A group can be deleted; a private chat cannot.
        
        A chat goes with its agent and has no separate existence to remove,
        so offering it there would be a second and more confusing route to
        what deleting the agent already does.
        
        A group needs this because it now survives its founder — without a
        way out, removing every member left a room nobody could delete and
        nothing could answer. The agents themselves are untouched; only the
        room and its transcript go.
      */}
      {group && (
        <footer className="modal-foot">
          {confirmDelete ? (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Really delete this room and its messages — the agents are kept
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirmDelete(true)}
            >
              Delete room
            </button>
          )}
        </footer>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* History — getting a conversation back                               */
/* ------------------------------------------------------------------ */

/**
 * Earlier versions of a conversation, and a way to restore one.
 *
 * A transcript is written whole, so anything that shortens one used to lose
 * the difference permanently. Versions are now kept automatically whenever a
 * write removes entries; this is where they become reachable.
 *
 * Deliberately phrased around what happened rather than the mechanism: "58
 * messages, before the chat was cleared" is what someone is looking for, not
 * a checkpoint identifier.
 */
export function HistoryPanel({
  points,
  onRestore,
  onClose,
}: {
  points: HistoryPoint[];
  onRestore: (file: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  /** Reasons read better as phrases than as bare labels. */
  const describe = (reason: string) => {
    switch (reason) {
      case 'cleared':
        return 'before the chat was cleared';
      case 'rewind':
        return 'before a rewind';
      case 'before restore':
        return 'before an earlier version was restored';
      default:
        return `before "${reason}"`;
    }
  };

  return (
    <Modal title="Conversation history" onClose={onClose} wide>
      <p className="muted">
        Earlier versions are kept whenever something removes messages — clearing the
        chat, rewinding, or restoring. Nothing is saved while a conversation is only
        growing, because nothing has been lost.
      </p>

      {points.length === 0 ? (
        <p className="muted">No earlier versions. This conversation has not lost any messages.</p>
      ) : (
        <div className="node-list">
          {points.map((point) => (
            <div key={point.file} className="node-row">
              <div className="node-main">
                <strong>
                  {point.entries} message{point.entries === 1 ? '' : 's'}
                </strong>
              </div>
              <div className="muted small">{describe(point.reason)}</div>
              <div className="muted small">{new Date(point.createdAt).toLocaleString()}</div>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => {
                  // The current conversation is checkpointed before being
                  // replaced, so this is reversible — worth saying, because
                  // otherwise restoring feels like a one-way door.
                  if (
                    !confirm(
                      `Restore ${point.entries} message${point.entries === 1 ? '' : 's'}? ` +
                        'The current conversation is saved first, so you can come back to it.',
                    )
                  ) {
                    return;
                  }
                  setBusy(point.file);
                  void onRestore(point.file).then((ok) => {
                    setBusy(null);
                    if (ok) onClose();
                  });
                }}
              >
                {busy === point.file ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}


/* ------------------------------------------------------------------ */
/* Nodes — the machines that run your agents                           */
/* ------------------------------------------------------------------ */

/**
 * Pair and manage the machines an agent can run on.
 *
 * The mental model this screen has to convey: an agent lives on one machine,
 * and that machine holds its conversation, its files and its credentials.
 * Everything here is phrased around that rather than around connections.
 */
export function NodesPanel({
  nodes,
  agents,
  onPair,
  onForget,
  onRefresh,
  onClose,
}: {
  nodes: NodeSummary[];
  agents: AgentRecord[];
  onPair: (address: string, code: string, fingerprint?: string) => Promise<string | null>;
  onForget: (nodeId: string) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!address.trim() || !code.trim()) {
      setError('Enter the address of the machine and the code it is showing.');
      return;
    }
    setBusy(true);
    const failure = await onPair(address.trim(), code.trim(), fingerprint.trim() || undefined);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setAdding(false);
    setAddress('');
    setCode('');
    setFingerprint('');
  };

  /** How many agents would stop working if this node were forgotten. */
  const agentsOn = (nodeId: string) => agents.filter((a) => a.nodeId === nodeId).length;

  return (
    <Modal title="Machines" onClose={onClose} wide>
      <p className="muted">
        Agents run on this computer unless you give them somewhere else. Pair a server, a
        spare PC or a Raspberry Pi and an agent can live there instead — with its own files
        and its own provider keys.
      </p>

      {nodes.length === 0 && !adding && (
        <p className="muted">
          No machines paired. Everything runs here.
        </p>
      )}

      <div className="node-list">
        {nodes.map((node) => {
          const count = agentsOn(node.id);
          return (
            <div key={node.id} className="node-row">
              <div className="node-main">
                <strong>{node.name}</strong>
                <span className={node.connected ? 'node-state online' : 'node-state offline'}>
                  {node.connected ? 'connected' : 'not reachable'}
                </span>
              </div>
              <div className="muted small">{node.address}</div>
              <div className="muted small">
                {count === 0
                  ? 'No agents assigned'
                  : `${count} agent${count === 1 ? '' : 's'} live here`}
              </div>
              {/* Shown so a user can compare it against the machine itself if
                  they ever suspect they are talking to the wrong one. */}
              <div className="muted tiny node-fingerprint">{node.fingerprint}</div>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const warning =
                    count > 0
                      ? `Forget ${node.name}? ${count} agent${count === 1 ? '' : 's'} live there ` +
                        'and will stop working until you pair it again. Their conversations stay ' +
                        'on that machine.'
                      : `Forget ${node.name}?`;
                  if (confirm(warning)) void onForget(node.id);
                }}
              >
                Forget
              </button>
            </div>
          );
        })}
      </div>

      {adding ? (
        <div className="node-form">
          <p className="muted small">
            On the other machine run <code>wispcrew serve --listen --network --pair</code>.
            It prints a code and a fingerprint.
          </p>
          {/*
            `.field` with a nested <span> is the form convention every other
            panel uses; a bare <label> gets no layout at all, which is how
            this modal ended up with its labels and inputs on one line.
          */}
          <label className="field">
            <span>Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.50:8787"
              spellCheck={false}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Pairing code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-EFGH-JKLM"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>
              Fingerprint <em className="muted">— optional, but recommended</em>
            </span>
            <input
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
              placeholder="SHA256:… as printed by the machine"
              spellCheck={false}
            />
          </label>
          <p className="muted small">
            Checking the fingerprint is what proves you are pairing with your machine and not
            something pretending to be it. The code works once and expires in five minutes.
          </p>
          {error && <div className="list-error">{error}</div>}
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Pairing…' : 'Pair'}
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            Pair a machine
          </button>
          {nodes.length > 0 && (
            <button type="button" className="btn" onClick={onRefresh}>
              Refresh
            </button>
          )}
        </div>
      )}
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
        machine; WispCrew spawns them with the command you provide.
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

export /**
 * Say what wakes a routine.
 *
 * There are three triggers now — a schedule, a one-shot follow-up, and a
 * filesystem watch — and a cron expression only describes the first. Showing
 * `r.cron` for the others rendered an empty code block and "next —", which
 * told the user nothing about work their agent had scheduled for itself.
 */
function describeTrigger(routine: RoutineRecord): ReactNode {
  const when = (at?: number) =>
    at ? new Date(at).toLocaleString() : 'not scheduled';

  if (routine.watchPath) {
    const folder = routine.watchPath.split(/[\\/]/).filter(Boolean).pop() ?? routine.watchPath;
    return (
      <>
        Watching <code>{routine.watchPattern ?? 'everything'}</code> in {folder}
      </>
    );
  }

  if (typeof routine.runAt === 'number') {
    // A one-shot that has already run is disabled rather than deleted, so the
    // user can still see what their agent did.
    return routine.enabled ? <>Once, at {when(routine.runAt)}</> : <>Ran once, {when(routine.runAt)}</>;
  }

  return (
    <>
      <code>{routine.cron}</code> · next {when(routine.nextRunAt)}
    </>
  );
}

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
                  {/*
                    Three kinds of trigger now, and a cron expression only
                    describes one. A watch has no schedule and a follow-up
                    fires once, so showing `r.cron` for either rendered an
                    empty <code> and "next —".
                  */}
                  {describeTrigger(r)}
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
