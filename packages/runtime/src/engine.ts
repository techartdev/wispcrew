/**
 * engine.ts — running agents, independent of any window.
 *
 * This is the part of WispCrew that does the work: expanding skills,
 * resolving which provider an agent uses, driving the agent loop, running
 * scheduled routines and handling delegation. It was previously inside the
 * Electron main process, which meant closing the window stopped it.
 *
 * Nothing here knows whether a user is watching. Transcript entries and run
 * state go to `emitEngineEvent`, which fans out to whatever is listening —
 * open windows, connected clients, or nothing at all when a routine fires on
 * a headless box at 3am. That last case is the one that matters: the engine
 * must behave identically with no observer.
 */
import type {
  AgentRecord,
  Attachment,
  GlobalSettings,
  RoutineRecord,
  TranscriptEntry,
} from '@wispcrew/shared';
import { Agent, personaById } from '@wispcrew/core';
import {
  configFromPreset,
  createProvider,
  describeProviderError,
  PROVIDER_PRESETS,
  type UsageSnapshot,
} from '@wispcrew/llm';
import { ToolRegistry } from '@wispcrew/tools';

import * as store from './store.js';
import { host } from './host.js';
import { readSettings } from './settings-file.js';
import { readSecrets } from './secrets-store.js';
import { providerSecretKey } from './provider-keys.js';
import { allStatuses, recordUsage, resolveToken, type OAuthVendor } from './oauth-store.js';
import { attachmentsToPromptText } from './attachments.js';
import { rebuildHistory } from './branching.js';
import { getSession, setRunning, clearSession } from './agent-sessions.js';
import { buildMcpTools } from './mcp-manager.js';
import {
  isTerminal,
  makeAskAgentTool,
  rootContext,
  TERMINAL_NOTICE,
  type DelegationContext,
} from './delegation.js';
import { emitEngineEvent } from './engine-events.js';
import { fileLog } from './filelog.js';

/** Set by the host; the engine never guesses where data lives. */
function dataDir(): string {
  return host().dataDir;
}

/** Persist a transcript entry and tell whoever is listening. */
export function pushTranscript(agentId: string, entry: TranscriptEntry): void {
  store.upsertTranscriptEntry(agentId, entry);
  emitEngineEvent({ type: 'transcript', agentId, entry });
}

/**
 * Ask a human to approve a tool call.
 *
 * Supplied by the host, because "ask the user" means different things: the
 * desktop raises an approval card and waits, while a daemon may have nobody
 * to ask at all.
 *
 * The default is **deny**. A routine firing unattended must not silently gain
 * permissions the user never granted just because no one was there to say no
 * — failing closed is the only safe reading of an unanswered question.
 */
export type ApprovalAsker = (
  agentId: string,
  req: { toolName: string; summary: string; detail?: string },
) => Promise<boolean>;

let askApproval: ApprovalAsker = async () => false;

export function setApprovalAsker(asker: ApprovalAsker): void {
  askApproval = asker;
}

function requestApproval(
  agentId: string,
  req: { toolName: string; summary: string; detail?: string },
): Promise<boolean> {
  return askApproval(agentId, req);
}

export function defaultSettings(): GlobalSettings {
  return {
    presetId: process.env.WISPCREW_PROVIDER ?? 'deepseek',
    model: process.env.WISPCREW_MODEL,
    baseUrl: process.env.WISPCREW_BASE_URL,
    approvalPolicy: 'ask',
    theme: 'system',
  };
}

/**
 * The credential a preset needs, and how to obtain it.
 *
 * Subscription presets resolve an OAuth access token (refreshing it when
 * stale) instead of an API key; everything else reads a key. Doing this in
 * one place means `runPrompt` and the connection test cannot diverge.
 */
async function resolveCredential(
  presetId: string,
): Promise<{ apiKey?: string; accountId?: string; error?: string }> {
  const vendor: OAuthVendor | null =
    presetId === 'chatgpt-subscription'
      ? 'chatgpt'
      : presetId === 'claude-subscription'
        ? 'anthropic'
        : null;

  if (!vendor) return { apiKey: resolveApiKey(presetId) };

  const credential = await resolveToken(dataDir(), vendor);
  if (!credential) {
    return {
      error:
        vendor === 'chatgpt'
          ? 'Not signed in to ChatGPT. Open Settings to sign in.'
          : 'Not signed in to Claude. Open Settings to sign in.',
    };
  }
  return {
    apiKey: credential.access,
    accountId: (credential as { accountId?: string }).accountId,
  };
}

/**
 * Read the API key for one provider.
 *
 * Keys are stored **per provider** (`WISPCREW_KEY_<preset>`), so several can
 * be configured at once and each agent uses the right one. This matters more
 * than it sounds: a single shared key meant an agent switched to OpenAI sent
 * an OpenAI key to whatever host the global settings pointed at — and the
 * provider that answered was not the one the error named.
 *
 * The legacy shared `WISPCREW_API_KEY` is still honoured as a last resort so
 * existing installs keep working; `migrateLegacyKey` moves it to its proper
 * home on startup.
 */
function resolveApiKey(presetId: string): string | undefined {
  const secrets = readSecrets(dataDir());
  return (
    secrets[providerSecretKey(presetId)] ??
    secrets.WISPCREW_API_KEY ??
    process.env.WISPCREW_API_KEY
  );
}

/**
 * Resolve the effective configuration for an agent: per-agent overrides win
 * over the global defaults, so one agent can run a cheap model in a scratch
 * directory while another uses a stronger model against a real project.
 */
async function effectiveConfig(agent: AgentRecord | undefined, settings: GlobalSettings) {
  const presetId = agent?.presetId ?? settings.presetId ?? 'deepseek';
  const credential = await resolveCredential(presetId);
  return {
    presetId,
    model: agent?.model ?? settings.model,
    /*
     * A custom Base URL belongs to the preset it was entered for.
     *
     * `presetId` and `model` honour a per-agent override, but `baseUrl` used
     * to be taken from global settings unconditionally — so an agent set to
     * OpenAI while the global provider was NVIDIA sent OpenAI's model name to
     * NVIDIA's host. The reply ("does not recognise gpt-5.6-terra") was
     * correct but came from the wrong provider, and the error named OpenAI,
     * making it look like a valid model had been rejected.
     *
     * The override now applies only when the agent is actually on the preset
     * the URL was configured for; otherwise the preset's own default host is
     * used. `custom` has no default host, so its URL always applies.
     */
    baseUrl:
      agent?.baseUrl ??
      (presetId === settings.presetId || presetId === 'custom' ? settings.baseUrl : undefined),
    workspaceRoot: agent?.workspaceRoot ?? settings.workspaceRoot ?? host().defaultWorkspaceRoot,
    approvalPolicy: agent?.approvalPolicy ?? settings.approvalPolicy ?? 'ask',
    persona: agent?.persona ?? settings.persona,
    apiKey: credential.apiKey,
    accountId: credential.accountId,
    /** Set when a subscription sign-in is required but absent. */
    credentialError: credential.error,
  };
}

/**
 * Build the system prompt for an agent.
 *
 * An explicit `description` is the agent's own durable instruction set and
 * takes precedence; otherwise we fall back to the chosen built-in persona.
 */

/**
 * Real state for the prompt: what this agent can actually do right now.
 *
 * Read from the store rather than asserted, so the description cannot drift
 * from the truth as routines are added or removed.
 */
function environmentOptions(agent: AgentRecord | undefined) {
  return {
    // A daemon owns the engine whenever one is attached, which is what makes
    // unattended work possible at all.
    persistent: true,
    routines: agent
      ? store
          .listRoutines(agent.id)
          .filter((r) => r.enabled !== false)
          .map((r) => `"${r.name}" (${r.cron})`)
      : [],
  };
}

/**
 * The environment block on its own, for prompts that replace the persona.
 *
 * Built by generating the general persona and slicing out the section, so
 * there is one source of these facts rather than two that can disagree.
 */
function environmentFacts(agent: AgentRecord | undefined, model?: string): string {
  const generic = personaById('general')?.build({
    modelHint: model,
    ...environmentOptions(agent),
  });
  if (!generic) return '';
  const start = generic.indexOf('## Your environment');
  const end = generic.indexOf('## How to work');
  return start === -1 || end === -1 ? '' : generic.slice(start, end).trim();
}

function systemPromptFor(agent: AgentRecord | undefined, personaId: string | undefined, model?: string) {
  /*
   * Describe the environment even when the user wrote their own prompt.
   *
   * A custom description replaces the persona entirely, which meant an agent
   * with standing instructions knew nothing about routines, persistence or
   * how to reach its user — and would confidently tell them it had no
   * scheduler. The user's words still lead; the facts about what this agent
   * runs inside are appended, because they are true either way and the model
   * cannot infer them.
   */
  const described = agent?.description?.trim();
  if (described) {
    const facts = environmentFacts(agent, model);
    return facts ? `${described}\n\n${facts}` : described;
  }
  return personaById(personaId)?.build({
    ...environmentOptions(agent),
    modelHint: model }) ?? undefined;
}

/**
 * Expand a leading `/skill` reference into that skill's instructions.
 *
 * The renderer does this too (so the user sees the expansion in their own
 * message), but it must also happen here: routines and any other non-UI
 * caller reach `runPrompt` directly and would otherwise send a literal
 * "/changelog" to the model.
 *
 * Expanding twice is harmless — after the first pass the text no longer
 * starts with a slash command.
 */
export function expandSkill(prompt: string): string {
  const m = /^\/([\w-]+)\s*([\s\S]*)$/.exec(prompt);
  if (!m) return prompt;
  const skill = store
    .listSkills()
    .find((s) => s.enabled && s.name.toLowerCase() === (m[1] ?? '').toLowerCase());
  if (!skill) return prompt;
  const rest = (m[2] ?? '').trim();
  return rest ? `${skill.body}\n\n---\n\n${rest}` : skill.body;
}

/**
 * Drop a trailing user message from a transcript.
 *
 * Callers append the user's message to the transcript before invoking
 * `runPrompt`, and `Agent.run` appends it to the model history itself. Seeding
 * a cold session from the raw transcript would therefore send it twice — which
 * the model reads as the user repeating themselves.
 */
function dropTrailingUserEntry(entries: TranscriptEntry[]): TranscriptEntry[] {
  const last = entries[entries.length - 1];
  if (last && last.kind === 'message' && last.role === 'user') return entries.slice(0, -1);
  return entries;
}

/**
 * Run one prompt for an agent, streaming results to the renderer.
 *
 * The assistant message keeps a single stable id and is rewritten as tokens
 * arrive, so the UI updates in place rather than accumulating fragments.
 */
export async function runPrompt(
  agentId: string,
  rawPrompt: string,
  attachments: Attachment[] = [],
  delegation?: DelegationContext,
): Promise<string> {
  const expanded = expandSkill(rawPrompt);
  // Non-image attachments are inlined ahead of the user's own words so the
  // model reads the material before the instruction about it. Images travel
  // separately as structured vision content.
  const attachmentText = attachmentsToPromptText(attachments);
  const prompt = attachmentText ? `${attachmentText}\n\n${expanded}`.trim() : expanded;
  const images = attachments.filter((a) => a.kind === 'image');
  const settings = readSettings(dataDir(), defaultSettings()) as GlobalSettings;
  const agent = store.getAgent(agentId);
  const cfg = await effectiveConfig(agent, settings);

  // A subscription preset with no sign-in fails here with a message that
  // names the fix, rather than reaching the provider and returning a 401.
  if (cfg.credentialError) {
    pushTranscript(agentId, {
      kind: 'notice',
      id: store.newId('err'),
      level: 'error',
      text: cfg.credentialError,
      createdAt: Date.now(),
    });
    emitEngineEvent({ type: 'run-state', agentId, state: 'error' });
    return cfg.credentialError;
  }

  const oauthVendor: OAuthVendor | null =
    cfg.presetId === 'chatgpt-subscription'
      ? 'chatgpt'
      : cfg.presetId === 'claude-subscription'
        ? 'anthropic'
        : null;

  const preset = {
    ...configFromPreset(cfg.presetId, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    }),
    // The Codex backend requires the account id alongside the token.
    ...(cfg.accountId ? { accountId: cfg.accountId } : {}),
    // Quota is only reported on a real response, so record it as turns run
    // and push it so an open Settings panel updates live.
    ...(oauthVendor
      ? {
          onUsage: (usage: UsageSnapshot) => {
            recordUsage(oauthVendor, usage);
            emitEngineEvent({ type: 'oauth-changed', statuses: allStatuses(dataDir()) });
          },
        }
      : {}),
  };
  const provider = createProvider(preset);
  const check = provider.validate();
  if (!check.ok) {
    pushTranscript(agentId, {
      kind: 'notice',
      id: store.newId('err'),
      level: 'error',
      // `validate()` already returns a complete, actionable sentence;
      // prefixing it just adds jargon in front of the useful part.
      text: check.error,
      createdAt: Date.now(),
    });
    emitEngineEvent({ type: 'run-state', agentId, state: 'error' });
    return check.error;
  }

  /*
   * Assistant text is written in *segments*, one per id.
   *
   * A turn interleaves prose and tool calls: the model says what it is about
   * to do, calls tools, then writes its answer. Transcript entries render in
   * insertion order, so reusing a single id for the whole turn pinned all the
   * prose at the position of the first token — and every tool card, created
   * later, appeared *below* the final answer even though it ran before it.
   * The transcript then read backwards: conclusions first, evidence after.
   *
   * Starting a new segment whenever a tool call arrives keeps the visible
   * order the same as the real order. `settleSegment` is called before any
   * tool card is pushed; the next token then opens a fresh entry underneath.
   */
  let segmentId = store.newId('asst');
  let text = '';
  /** Text already committed to earlier segments, for the final return value. */
  let priorText = '';

  const flush = (streaming: boolean) => {
    // An empty segment would render as a blank bubble; skip it. This happens
    // whenever a turn ends with a tool call rather than prose.
    if (!text && !streaming) return;
    const entry: TranscriptEntry = {
      kind: 'message',
      id: segmentId,
      role: 'assistant',
      content: text,
      isStreaming: streaming,
      createdAt: Date.now(),
    };
    pushTranscript(agentId, entry);
  };

  /** Close the current text segment so what follows appears after it. */
  const settleSegment = () => {
    if (!text) return;
    flush(false);
    priorText = priorText ? `${priorText}\n\n${text}` : text;
    text = '';
    segmentId = store.newId('asst');
  };

  // A delegated run inherits the caller's (possibly narrowed) policy so an
  // agent cannot gain permissions by asking a more privileged agent to act
  // for it. A top-level run starts a fresh delegation chain.
  const chain = delegation ?? rootContext(cfg.approvalPolicy, agentId);
  const effectivePolicy = delegation ? delegation.policy : cfg.approvalPolicy;

  // Built-in tools plus anything the configured MCP servers expose.
  const tools = new ToolRegistry();
  for (const tool of await buildMcpTools(settings as never)) tools.register(tool);
  // Delegation: only offered when another agent exists and we are within the
  // depth limit (`makeAskAgentTool` returns null otherwise).
  const askAgent = makeAskAgentTool(agentId, chain, runDelegated);
  if (askAgent) tools.register(askAgent as never);
  for (const name of agent?.disabledTools ?? []) tools.unregister(name);

  const fingerprint = JSON.stringify({
    presetId: cfg.presetId,
    model: preset.model,
    baseUrl: preset.baseUrl,
    hasKey: Boolean(cfg.apiKey),
    persona: cfg.persona ?? '',
    description: agent?.description ?? '',
    workspaceRoot: cfg.workspaceRoot,
    policy: effectivePolicy,
    // The delegation roster and depth change the tool set, so a session
    // built at one depth must not be reused at another.
    delegates: askAgent ? askAgent.definition.description.length : 0,
    mcp: (settings.mcpServers ?? []).map(
      (s) => `${s.name}:${s.command}:${(s.args ?? []).join(' ')}:${s.disabled ? 0 : 1}`,
    ),
  });

  const session = getSession(agentId, {
    provider,
    tools,
    workspaceRoot: cfg.workspaceRoot,
    systemPrompt: systemPromptFor(agent, cfg.persona, preset.model),
    fingerprint,
    // Cold start: rebuild what the model should remember from the transcript
    // the user can see. Without this, restarting the app (or opening a
    // freshly branched agent) left the model with no memory of a
    // conversation plainly visible on screen.
    //
    // The caller has already appended this turn's user message to the
    // transcript, and `Agent.run` appends it again — so the trailing user
    // entry is dropped here to avoid sending it twice.
    initialHistory: rebuildHistory(dropTrailingUserEntry(store.loadTranscript(agentId))),
    onApprovalRequired: async (req) => {
      // `readonly` denies anything needing approval; `auto` grants it.
      if (effectivePolicy === 'readonly') return false;
      if (effectivePolicy === 'auto') return true;
      return requestApproval(agentId, {
        toolName: req.toolName,
        summary: req.summary,
        detail: req.detail,
      });
    },
  });

  // The Agent is reused across turns, so rebind the sink for this run.
  session.setEventSink((e) => {
    if (e.type === 'delta') {
      text += e.text;
      flush(true);
    } else if (e.type === 'tool_call_start') {
      // Close any prose written before this call so the card lands *after*
      // it, and the answer the model writes next lands after the card.
      settleSegment();
      pushTranscript(agentId, {
        kind: 'tool-call',
        id: e.call.id,
        toolName: e.call.name,
        args: e.call.args,
        status: 'running',
        createdAt: Date.now(),
      });
    } else if (e.type === 'tool_call_result') {
      pushTranscript(agentId, {
        kind: 'tool-call',
        id: e.result.id,
        toolName: e.result.name,
        status: e.result.ok ? 'completed' : e.result.errorCode === 'denied' ? 'denied' : 'failed',
        content: e.result.content.slice(0, 4000),
        createdAt: Date.now(),
      });
    } else if (e.type === 'error') {
      // A fatal error is rethrown by `Agent.run` and reported below with a
      // message the user can act on. Emitting the raw text here too would
      // show the same failure twice — once as "fetch failed", once as the
      // explanation. Non-fatal notices (e.g. "Turn aborted by user") have no
      // second chance, so they are still shown.
      if (e.fatal) return;
      pushTranscript(agentId, {
        kind: 'notice',
        id: store.newId('err'),
        level: 'error',
        text: e.message,
        createdAt: Date.now(),
      });
    }
  });

  setRunning(agentId, true);
  emitEngineEvent({ type: 'run-state', agentId, state: 'thinking' });
  /*
   * No placeholder entry is pushed here.
   *
   * Emitting an empty assistant message up front reserved a transcript slot
   * *above* anything the turn did next, so a turn that began with a tool call
   * showed the card below the answer — the very ordering this segmenting is
   * meant to fix. The "thinking" run-state above already tells the UI work
   * has started; the first delta creates the entry, in the right place.
   */

  try {
    const final = await session.run(prompt, images);
    /*
     * `final.content` is the whole turn's text, but streaming has already
     * placed each segment in the transcript. Overwriting the current segment
     * with it would repeat everything written before the last tool call.
     *
     * So only adopt it when nothing was streamed at all — a non-streaming
     * provider, or a turn whose text never arrived as deltas.
     */
    if (!text && !priorText) text = final.content;
  } catch (err) {
    // Raw provider failures are hostile — an HTTP 401 arrives as a wall of
    // JSON, a wrong base URL as the single word "fetch failed". Translate to
    // something that says what to change. A user-initiated Stop returns null
    // and is not reported as an error at all.
    const friendly = describeProviderError(err, {
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
    });
    if (friendly) {
      pushTranscript(agentId, {
        kind: 'notice',
        id: store.newId('err'),
        level: 'error',
        text: friendly,
        createdAt: Date.now(),
      });
    }
  } finally {
    setRunning(agentId, false);
    flush(false);
    emitEngineEvent({ type: 'run-state', agentId, state: 'idle' });
  }
  // Callers (routines, delegation) want the turn's whole answer, which may
  // span several segments.
  return priorText ? (text ? `${priorText}\n\n${text}` : priorText) : text;
}

/**
 * Run a prompt on a delegate and return its answer to the calling agent.
 *
 * The delegate's work is written to its own transcript — the user can open
 * that agent and read exactly what it was asked and what it did, rather than
 * the delegation being an invisible side effect. A notice marks where the
 * request came from.
 */
export async function runDelegated(
  targetId: string,
  task: string,
  chain: DelegationContext,
): Promise<string> {
  const caller = store.getAgent(chain.stack[chain.stack.length - 2] ?? '');
  pushTranscript(targetId, {
    kind: 'notice',
    id: store.newId('note'),
    level: 'info',
    text: `Task delegated by ${caller?.name ?? 'another agent'}.`,
    createdAt: Date.now(),
  });
  pushTranscript(targetId, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: task,
    createdAt: Date.now(),
  });

  // Tell a terminal delegate that the buck stops with it. Otherwise an agent
  // whose instructions say "always hand this on" just finds no ask_agent tool
  // and echoes the request back instead of answering.
  const effectiveTask = isTerminal(targetId, chain) ? `${task}${TERMINAL_NOTICE}` : task;
  const answer = await runPrompt(targetId, effectiveTask, [], chain);
  return answer.trim() || '(the agent returned no text)';
}

/** Execute a routine by sending its prompt to the owning agent. */
export async function runRoutine(routine: RoutineRecord): Promise<void> {
  pushTranscript(routine.agentId, {
    kind: 'notice',
    id: store.newId('note'),
    level: 'info',
    text: `Routine "${routine.name}" started.`,
    createdAt: Date.now(),
  });
  pushTranscript(routine.agentId, {
    kind: 'message',
    id: store.newId('usr'),
    role: 'user',
    content: routine.prompt,
    createdAt: Date.now(),
  });
  await runPrompt(routine.agentId, routine.prompt);
}

