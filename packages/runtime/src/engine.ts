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
import type { SkillRecord } from '@wispcrew/shared';
import type {
  AgentRecord,
  Attachment,
  GlobalSettings,
  RoutineRecord,
  TranscriptEntry,  ChannelId,
} from '@wispcrew/shared';
import {
  Agent,
  personaById,
  environmentFacts as coreEnvironmentFacts,
  type SystemPromptOptions,
} from '@wispcrew/core';
import {
  configFromPreset,
  createProvider,
  describeProviderError,
  PROVIDER_PRESETS,
  type UsageSnapshot,
} from '@wispcrew/llm';
import { ToolRegistry, readSkillTool } from '@wispcrew/tools';

import * as store from './store.js';
import { checkModelPairing } from './config-check.js';
import { claimTurn, updateTurn } from './turns.js';
import { host } from './host.js';
import { getConversation } from './conversations.js';
import { downgradeNotice, resolvePolicy } from './approval-policy.js';
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

/**
 * The asker currently installed.
 *
 * Exists so a caller can install one for the duration of a single turn and
 * restore the previous one afterwards. That is how a turn started from
 * Telegram gets to ask the phone, while an agent waking on a SCHEDULE does
 * not — otherwise a compromised chat could be presented with a request at
 * any moment rather than only in reply to something the user did.
 */
export function currentApprovalAsker(): ApprovalAsker {
  return askApproval;
}

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
 * Resolve the effective configuration for an agent.
 *
 * ## The provider and the model come from the agent, and nowhere else
 *
 * These used to fall back: `agent.presetId ?? settings.presetId ?? 'deepseek'`
 * and `agent.model ?? settings.model`. That chain was the largest single
 * source of agents that looked configured and could not work, because the
 * two halves fell back independently. In practice the model was set on the
 * agent and the provider was not, so they came from different places and
 * nothing ever compared them — producing an OpenAI model aimed at NVIDIA,
 * which answers `404 page not found` and always will.
 *
 * Worse, the failure moved. Changing the global provider silently changed
 * where every inheriting agent sent its requests, so an agent that worked
 * yesterday failed today with nothing about it having been edited.
 *
 * There is no fallback now. An agent carries both, always, chosen together.
 * `migrateAgentsToExplicitProvider` writes them into records that predate
 * this, and the store refuses to create one without them.
 *
 * Everything else still inherits, and should: a workspace, an approval
 * policy and a persona are all safe to leave at a sensible default, and
 * none of them can silently point a request at the wrong company.
 */
async function effectiveConfig(agent: AgentRecord, settings: GlobalSettings) {
  const presetId = agent.presetId;
  const credential = await resolveCredential(presetId);
  return {
    presetId,
    model: agent.model,
    /*
     * A custom Base URL belongs to the agent, or to its preset.
     *
     * It used to be readable from global settings when the agent happened
     * to be on the same preset the URL was entered for — a coupling that
     * existed only because the provider was inherited too. With the
     * provider on the agent, the agent's own `baseUrl` is the only
     * override, and everything else uses the preset's published host.
     */
    baseUrl: agent.baseUrl,
    // The same resolution the prompt uses, so what an agent is TOLD about
    // its boundary and where it is actually confined cannot drift apart.
    workspaceRoot: resolveWorkspaceRoot(agent),
    approvalPolicy: agent.approvalPolicy ?? settings.approvalPolicy ?? 'ask',
    persona: agent.persona ?? settings.persona,
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
function environmentOptions(agent: AgentRecord | undefined, conversationId?: string) {
  /*
   * Who else is in the room.
   *
   * Only when there is actually company: telling a lone agent it is "in a
   * conversation with @itself" is noise, and the single-agent case is still
   * the common one.
   */
  let room: SystemPromptOptions['room'];

  if (agent && conversationId) {
    const conversation = getConversation(conversationId);
    const participants = conversation?.participants ?? [];

    // Only when there is actually company. Telling a lone agent who is in
    // the room is noise, and one agent is still the common case.
    const agentCount = participants.filter((p) => p.kind === 'agent').length;

    /*
     * A greeting is reason enough on its own.
     *
     * A group whose members left down to one still has standing
     * instructions, and dropping them because of a head count would change
     * how the remaining agent behaves for a reason nobody could see. The
     * prompt renders the two parts independently.
     */
    const greeting = conversation?.greeting?.trim() ? conversation.greeting : undefined;

    if (agentCount > 1 || greeting) {
      room = {
        mode: conversation?.mode,
        greeting,
        // Only a room with a name of its own; a direct chat's title is just
        // the agent's name, and "## This room: Assistant" says nothing.
        title: conversation?.kind === 'group' ? conversation.title : undefined,
        participants: participants.map((p) => {
          if (p.kind === 'human') {
            /*
             * How to reach this person, in the words the prompt uses.
             *
             * It changes what a good reply looks like: someone answering
             * from Telegram is not looking at the transcript, so a reply
             * that says "see the file above" is useless to them.
             */
            const doors = p.channels
              .filter((c) => c !== 'app')
              .map((c) => (c === 'telegram' ? 'Telegram' : 'desktop notifications'));

            return {
              kind: 'human' as const,
              name: p.name,
              via: doors.length
                ? `a person, at the app and reachable on ${doors.join(' and ')}`
                : 'a person, at the app',
            };
          }

          /*
           * Which machine an agent runs on, because it bounds what it can
           * see: an agent elsewhere cannot read this machine's files, so
           * asking it to is a wasted turn.
           */
          const other = store.getAgent(p.id);
          const elsewhere = other?.nodeId && other.nodeId !== agent.nodeId;

          return {
            kind: 'agent' as const,
            name: other?.name ?? p.handle,
            handle: p.handle,
            via: elsewhere ? 'an agent on another machine' : 'an agent on this machine',
          };
        }),
      };
    }
  }

  const self = agent
    ? (getConversation(conversationId ?? agent.id)?.participants ?? []).find(
        (p) => p.kind === 'agent' && p.id === agent.id,
      )
    : undefined;

  return {
    agentName: agent?.name,
    handle: self && self.kind === 'agent' ? self.handle : undefined,

    /*
     * Where this actually runs. Read from the host rather than assumed, so
     * an agent on a VPS says so instead of describing the user's laptop.
     */
    machineName: host().nodeName,
    platform: platformName(),
    /*
     * The SAME root the tools are actually confined to.
     *
     * This skipped the global `workspaceRoot` setting and fell straight to
     * the host default, while `effectiveConfig` — which is what the file and
     * shell tools receive — reads the setting first. So an installation with
     * a global workspace told every agent it lived in `~/.wispcrew/workspace`
     * and then let it read and write somewhere else entirely.
     *
     * Found live: an agent asked about its room searched a source tree it
     * had just been told it could not see. The prompt was wrong, not the
     * sandbox — but a prompt that misstates the boundary is the same class
     * of failure as one that misstates a capability, and this file's whole
     * rule is that every line is the host's real state.
     */
    workspace: resolveWorkspaceRoot(agent),

    // A daemon owns the engine whenever one is attached, which is what makes
    // unattended work possible at all.
    persistent: true,
    routines: agent
      ? store
          .listRoutines(agent.id)
          .filter((r) => r.enabled !== false)
          .map((r) => `"${r.name}" (${r.cron})`)
      : [],
    room,
  };
}

/**
 * Where an agent's file and shell tools are confined.
 *
 * One function because two answers is how the prompt and the sandbox came
 * to disagree: the agent's own root, then the global setting, then the
 * host's default. `effectiveConfig` resolves it the same way for the tools,
 * and both now read from here.
 */
function resolveWorkspaceRoot(agent: AgentRecord | undefined): string {
  const settings = readSettings(dataDir(), defaultSettings()) as GlobalSettings;
  return agent?.workspaceRoot ?? settings.workspaceRoot ?? host().defaultWorkspaceRoot;
}

/** The operating system in the words a person would use. */
function platformName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/**
 * The facts on their own, for prompts that replace the persona.
 *
 * Was built by generating the general persona and SLICING OUT the section
 * between two headings — which worked until a heading was renamed, and would
 * have silently returned nothing. The core now exposes the same composition
 * directly, so there is one source and no string surgery.
 */
function factsFor(
  agent: AgentRecord | undefined,
  model?: string,
  conversationId?: string,
): string {
  return coreEnvironmentFacts({
    modelHint: model,
    ...environmentOptions(agent, conversationId),
  });
}

function systemPromptFor(
  agent: AgentRecord | undefined,
  personaId: string | undefined,
  model?: string,
  conversationId?: string,
) {
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
    const facts = factsFor(agent, model, conversationId);
    return facts ? `${described}\n\n${facts}` : described;
  }
  return personaById(personaId)?.build({
    ...environmentOptions(agent, conversationId),
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
  const body = withSectionIndex(skill);
  return rest ? `${body}\n\n---\n\n${rest}` : body;
}

/**
 * The skill body, plus a menu of what else it knows.
 *
 * Names and one-line descriptions only. The point of sections is that a
 * thorough skill stays affordable: a fifty-command CLI reference costs a
 * few hundred tokens until somebody actually asks about pairing a machine,
 * and then costs one section rather than all of them.
 *
 * The agent is told how to fetch them, because a list of topics with no
 * stated way to open them invites a model to invent the contents instead.
 */
export function withSectionIndex(skill: SkillRecord): string {
  if (!skill.sections?.length) return skill.body;

  const index = skill.sections
    .map((s) => `- \`${s.name}\` — ${s.description}`)
    .join('\n');

  return [
    skill.body,
    '',
    `## More in this skill`,
    '',
    'Not included above. Read one with the `read_skill` tool when it applies',
    `— \`read_skill(skill: "${skill.name}", section: "…")\`. Do not guess at`,
    'their contents; the point of them is that they are exact.',
    '',
    index,
  ].join('\n');
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
/** Anything a caller needs to say that is not one of the positional six. */
export interface RunOptions {
  /**
   * True when nobody is waiting on this turn.
   *
   * A routine, a file watch or a self-scheduled follow-up runs with the
   * window possibly closed, so `notify_user` is how it reports at all. A
   * turn a person just typed is one they are reading, and notifying as well
   * is duplicate — measured: two notifications for two questions, then one
   * combined answer, which reads as a malfunction.
   */
  unattended?: boolean;
}

export async function runPrompt(
  agentId: string,
  rawPrompt: string,
  attachments: Attachment[] = [],
  delegation?: DelegationContext,
  /*
   * Which door this request arrived through.
   *
   * Undefined means the local app, which is the ordinary case. A remote
   * channel does not inherit `auto`: an agent trusted to run unattended at
   * the desk is not thereby trusted to run shell commands for anyone
   * holding the user's phone.
   */
  channel?: ChannelId,
  /*
   * Where this run's output belongs.
   *
   * An agent used to own its conversation, so the two were the same file.
   * In a room with several agents they are not: the second agent would
   * write its replies into its OWN transcript, and the room would look
   * empty. Measured, not theorised — `@all` produced two runs and no
   * visible answers.
   *
   * Defaults to the agent's own id, which is what a single-agent
   * conversation has always meant.
   */
  transcriptId?: string,
  opts?: RunOptions,
): Promise<string> {
  /*
   * Where this run's output goes.
   *
   * An agent used to own its conversation, so `agentId` served as both.
   * In a room with several agents they differ, and writing to the agent's
   * own file made the second agent's replies invisible — the room looked
   * empty while two runs were happening.
   */
  const outputId = transcriptId ?? agentId;

  const expanded = expandSkill(rawPrompt);
  // Non-image attachments are inlined ahead of the user's own words so the
  // model reads the material before the instruction about it. Images travel
  // separately as structured vision content.
  const attachmentText = attachmentsToPromptText(attachments);
  const prompt = attachmentText ? `${attachmentText}\n\n${expanded}`.trim() : expanded;
  const images = attachments.filter((a) => a.kind === 'image');
  const settings = readSettings(dataDir(), defaultSettings()) as GlobalSettings;
  const agent = store.getAgent(agentId);

  /*
   * No record, no run.
   *
   * Reachable when an agent is deleted while a turn is in flight, or when a
   * room still lists a member that has gone. It used to proceed on the
   * global provider and model — a turn with no name, on somebody else's
   * settings, writing into a transcript nobody owns. With inheritance gone
   * there is nothing left to proceed WITH, which is the honest answer
   * anyway: say so, and stop.
   */
  if (!agent) {
    pushTranscript(outputId, {
      kind: 'notice',
      id: store.newId('err'),
      level: 'error',
      text: 'That agent no longer exists, so the message was not sent.',
      createdAt: Date.now(),
    });
    emitEngineEvent({ type: 'run-state', agentId: outputId, state: 'idle' });
    return '';
  }

  const cfg = await effectiveConfig(agent, settings);

  // A subscription preset with no sign-in fails here with a message that
  // names the fix, rather than reaching the provider and returning a 401.
  if (cfg.credentialError) {
    pushTranscript(outputId, {
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
    pushTranscript(outputId, {
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
      /*
       * WHO said it.
       *
       * User messages have carried an author since rooms existed; assistant
       * messages never did, because a conversation had exactly one agent by
       * construction. In a room with several, the transcript therefore did
       * not record who spoke at all — so every reply was displayed under
       * whichever agent the room was rooted at, and after the room got a
       * name of its own it would have been displayed under the ROOM.
       *
       * Recorded on the entry rather than inferred from the turn: a
       * transcript is read long after the turn is gone, and by other hosts.
       */
      authorId: agentId,
      isStreaming: streaming,
      createdAt: Date.now(),
    };
    pushTranscript(outputId, entry);
  };

  /** Close the current text segment so what follows appears after it. */
  const settleSegment = () => {
    if (!text) return;
    flush(false);
    priorText = priorText ? `${priorText}\n\n${text}` : text;
    text = '';
    segmentId = store.newId('asst');
  };

  /*
   * Resolve the policy for the door this request came through.
   *
   * Three levels: the agent's setting for this channel, then the agent's
   * setting, then the global default. An inherited `auto` is reduced to
   * `ask` on a remote channel — trusting an agent to act unattended while
   * you watch it is not the same as trusting anyone holding your phone.
   */
  const resolved = resolvePolicy(agent, settings as never, channel);

  if (resolved.downgraded) {
    // Say so, or "it asked me again" is indistinguishable from a bug.
    pushTranscript(outputId, {
      kind: 'notice',
      id: store.newId('note'),
      level: 'info',
      text: downgradeNotice(agent?.name ?? 'This agent', channel!),
      createdAt: Date.now(),
    });
  }

  // A delegated run inherits the caller's (possibly narrowed) policy so an
  // agent cannot gain permissions by asking a more privileged agent to act
  // for it. A top-level run starts a fresh delegation chain.
  /*
   * Room-mates are not delegates.
   *
   * An agent in a room is addressed with `@handle` and answers in front of
   * everyone; a delegate is asked privately and reports back. Offering both
   * made an agent hand its question to a room-mate rather than answer it.
   */
  /*
   * Ask the room, not the ids.
   *
   * An earlier version skipped this whenever `outputId === agentId`, on the
   * assumption that meant "no room". It does not: a migrated room REUSES its
   * first agent's id, so the agent whose id names the room was still offered
   * its own room-mates as delegates. Measured — two delegations in a room
   * that should have had none.
   */
  const roomMembers = (getConversation(outputId)?.participants ?? [])
    .filter((p) => p.kind === 'agent')
    .map((p) => p.id);

  /*
   * Refuse a turn that cannot possibly work, BEFORE spending anything.
   *
   * An agent created through the CLI had its provider inherited (NVIDIA)
   * and its model set to `gpt-5.6-terra`, which is OpenAI's. Every turn was
   * a request NVIDIA answers 404 to and always will — retried, then
   * reported as a provider error, in a room where other agents were
   * spending real tokens waiting on it.
   *
   * Narrow on purpose, and it fires on two kinds of certainty: another
   * vendor explicitly claims the model name, or the provider published a
   * catalogue this process has fetched and the model is absent from it.
   * Anything less certain proceeds, because blocking a working
   * configuration would be worse than the failure it prevents.
   *
   * Both values come off the agent now. Inheritance was how the pairing
   * went wrong in the first place — the model set explicitly on the agent,
   * the provider not set at all, the two arriving from different places
   * with nothing comparing them. This check survives the removal of that
   * chain because a person can still type a model by hand, which is the one
   * remaining way to get it wrong.
   */
  const problem = checkModelPairing(agent.presetId, agent.model);
  if (problem) {
    pushTranscript(outputId, {
      kind: 'notice',
      id: store.newId('note'),
      level: 'error',
      text: problem.message,
      createdAt: Date.now(),
    });
    emitEngineEvent({ type: 'run-state', agentId: outputId, state: 'idle' });
    // No reply text: the notice above is the whole outcome, and inventing
    // an assistant message here would put the error in the agent's mouth.
    return '';
  }

  const chain = delegation ?? rootContext(resolved.policy, agentId, roomMembers);
  const effectivePolicy = delegation ? delegation.policy : resolved.policy;

  // Built-in tools plus anything the configured MCP servers expose.
  const tools = new ToolRegistry();
  for (const tool of await buildMcpTools(settings as never)) tools.register(tool);
  // Delegation: only offered when another agent exists and we are within the
  // depth limit (`makeAskAgentTool` returns null otherwise).
  const askAgent = makeAskAgentTool(agentId, chain, runDelegated);
  if (askAgent) tools.register(askAgent as never);

  /*
   * Only when a skill actually has sections to read.
   *
   * A tool that is offered gets used (hard rule 11), and an agent given
   * `read_skill` with nothing to read will eventually call it — inventing a
   * skill name to try. Registering it conditionally means the option does
   * not exist rather than merely being pointless.
   */
  if (store.listSkills().some((s) => s.enabled && s.sections?.length)) {
    tools.register(readSkillTool as never);
  }

  for (const name of agent?.disabledTools ?? []) tools.unregister(name);

  /*
   * `notify_user` interrupts someone who is away.
   *
   * A turn a person just typed is one they are reading: the reply already
   * reaches them, so a notification as well is duplicate and reads as a
   * malfunction. Measured — two notifications for two questions, then one
   * combined answer.
   *
   * Prose did not stop it. The description says plainly "do NOT use it to
   * answer a message they just sent", and a model called it twice anyway,
   * because a tool that is offered gets used. Same lesson as the delegation
   * fix, same remedy: withhold it when it cannot be the right choice.
   *
   * A routine, a file watch or a self-scheduled follow-up keeps it, because
   * for those it is the only way to report at all.
   */
  if (!opts?.unattended) tools.unregister('notify_user');

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
    // Same reason: `notify_user` is withheld for an attended turn, so a
    // session built for a routine must not be reused for a typed message.
    unattended: Boolean(opts?.unattended),
    mcp: (settings.mcpServers ?? []).map(
      (s) => `${s.name}:${s.command}:${(s.args ?? []).join(' ')}:${s.disabled ? 0 : 1}`,
    ),
  });

  const session = getSession(agentId, {
    provider,
    tools,
    workspaceRoot: cfg.workspaceRoot,
    // `outputId` names the room when there is one, so an agent in company is
    // told so — otherwise it cannot tell that `@sums` addresses it, or that
    // its reply will be read by everyone.
    systemPrompt: systemPromptFor(agent, cfg.persona, preset.model, outputId),
    fingerprint,
    // Cold start: rebuild what the model should remember from the transcript
    // the user can see. Without this, restarting the app (or opening a
    // freshly branched agent) left the model with no memory of a
    // conversation plainly visible on screen.
    //
    // The caller has already appended this turn's user message to the
    // transcript, and `Agent.run` appends it again — so the trailing user
    // entry is dropped here to avoid sending it twice.
    initialHistory: rebuildHistory(dropTrailingUserEntry(store.loadTranscript(outputId))),
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
      pushTranscript(outputId, {
        kind: 'tool-call',
        id: e.call.id,
        toolName: e.call.name,
        args: e.call.args,
        status: 'running',
        createdAt: Date.now(),
      });
    } else if (e.type === 'tool_call_result') {
      pushTranscript(outputId, {
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
      pushTranscript(outputId, {
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
      pushTranscript(outputId, {
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
  /*
   * Recorded as a task, so the run can be found afterwards.
   *
   * Turns were claimed only by room turns, which meant scheduled work left
   * no trace an operator could query — `wispcrew tasks` showed what a
   * person had started and nothing that happened while they slept. Exactly
   * the wrong way round for a headless machine.
   *
   * The trigger id is the routine's, so several firings of the same routine
   * are distinguishable from one another.
   */
  const turn = claimTurn({
    conversationId: routine.agentId,
    triggerEntryId: `routine_${routine.id}_${Date.now()}`,
    agentId: routine.agentId,
  });

  if (turn) updateTurn(turn.id, { state: 'running' });

  try {
    /*
     * Unattended by definition.
     *
     * A routine fires whether or not anyone is looking, so `notify_user` is
     * the only way it can report — which is exactly why it is withheld from
     * turns a person typed.
     */
    await runPrompt(routine.agentId, routine.prompt, [], undefined, undefined, undefined, {
      unattended: true,
    });

    if (turn) updateTurn(turn.id, { state: 'completed' });
  } catch (err) {
    /*
     * A failed routine must be visible as failed, not merely absent. An
     * operator looking for why nothing happened needs the reason, and the
     * transcript alone does not survive a trimmed conversation.
     */
    if (turn) updateTurn(turn.id, { state: 'failed', detail: (err as Error).message });
    throw err;
  }
}

