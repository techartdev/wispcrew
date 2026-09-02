/**
 * provider-migration.ts — write an inherited provider and model onto the
 * agents that were relying on it.
 *
 * Until now `presetId` and `model` were optional, and an agent that set
 * neither ran on whatever the global settings happened to say. That is gone:
 * an agent carries both, always. This is what stops the change from breaking
 * every profile that already exists.
 *
 * ## The rule is "nothing changes behaviour"
 *
 * Each agent is given exactly what it resolves to TODAY — the same values
 * `effectiveConfig` would have computed a moment before this ran. An agent
 * that worked keeps working, on the same provider, with the same model. The
 * migration is meant to be invisible, and the only visible thing it does is
 * report a pairing that was ALREADY broken.
 *
 * ## Why the broken ones are reported rather than repaired
 *
 * One agent in the profile that prompted this had an OpenAI model on an
 * inherited NVIDIA provider — a request NVIDIA answers `404 page not found`
 * to and always will. Both repairs are plausible (change the model to an
 * NVIDIA one, or change the provider to OpenAI) and they mean completely
 * different things. Guessing would quietly move an agent to a different
 * company's model; that is the user's decision, so the migration writes the
 * values down faithfully, names the problem, and leaves it.
 *
 * ## A limit worth knowing: agents that live somewhere else
 *
 * The desktop's roster is a client-side MIRROR of every node's agents, so
 * this runs over records for agents that actually live on another machine —
 * and it fills them from THIS machine's settings, which is a guess about
 * somewhere else.
 *
 * That guess is display-only and self-correcting. A turn for a remote agent
 * is routed to its own node, which resolves the config from its own record
 * after running this same migration against its own settings. The Configure
 * panel already says "As configured on <machine>" for exactly this reason.
 * The mirror is filled rather than left blank because a roster row with no
 * provider reads as broken, and it is not.
 */
import type { AgentRecord, GlobalSettings } from '@wispcrew/shared';
import { checkModelPairing } from './config-check.js';
import { getPreset } from '@wispcrew/llm';
import { fileLog } from './filelog.js';
import { readSettings } from './settings-file.js';
import { host } from './host.js';
import * as store from './store.js';

/** What the migration did, so a host can report it rather than guess. */
export interface ProviderMigrationResult {
  /** Agents given an explicit provider and model. */
  filled: { id: string; name: string; presetId: string; model: string }[];
  /**
   * Agents whose pairing cannot work, whether or not this run touched them.
   *
   * Reported every time, not only when something was filled in: a bad
   * pairing that a user typed by hand deserves the same warning as one that
   * inheritance produced.
   */
  broken: { id: string; name: string; presetId: string; model: string; why: string }[];
}

/**
 * The last-resort provider, matching what `effectiveConfig` used to assume.
 *
 * Only reached by an agent with no provider on a profile whose settings name
 * none either — a store written before any provider was configured. Kept
 * identical to the old default so this migration cannot change where such an
 * agent points.
 */
const LEGACY_FALLBACK_PRESET = 'deepseek';

/**
 * Give every agent an explicit provider and model.
 *
 * Idempotent: an agent that already has both is untouched, so both hosts may
 * call this at startup and either may go first.
 */
export function migrateAgentsToExplicitProvider(): ProviderMigrationResult {
  // `{}` rather than the engine's defaults: this only reads `presetId` and
  // `model`, and importing the engine here would be a cycle.
  const settings = readSettings(host().dataDir, {}) as GlobalSettings;
  const agents = store.listAgents();

  const result: ProviderMigrationResult = { filled: [], broken: [] };
  const next: AgentRecord[] = [];
  let changed = 0;

  for (const agent of agents) {
    /*
     * Read as it may be ON DISK, not as the type now promises.
     *
     * `presetId` and `model` are required on `AgentRecord`, which is the
     * point of this change — but the whole reason this function exists is
     * that records written before that requirement do not have them. Typing
     * the loop variable as the new shape would make the compiler certain of
     * exactly the thing being repaired.
     */
    const onDisk = agent as Partial<AgentRecord>;
    const presetId = onDisk.presetId?.trim();
    const model = onDisk.model?.trim();

    let resolvedPreset: string | undefined = presetId;
    let resolvedModel: string | undefined = model;

    if (!resolvedPreset) {
      // Exactly the old chain, so an inheriting agent lands where it already
      // was rather than somewhere merely reasonable.
      resolvedPreset = settings.presetId?.trim() || LEGACY_FALLBACK_PRESET;
    }

    if (!resolvedModel) {
      /*
       * The global model, then the preset's own default.
       *
       * The second step matters: `effectiveConfig` passed an undefined model
       * to the provider adapter, which filled in the preset default. Reading
       * the settings alone would leave the field empty and make the agent
       * uncreatable under the new rule.
       */
      resolvedModel = settings.model?.trim() || getPreset(resolvedPreset)?.defaultModel;
    }

    if (!resolvedModel) {
      /*
       * Nothing to write. Only reachable for a preset this build does not
       * know — someone's fork, or a record from a newer version. Left
       * exactly as it is: an agent that cannot be described is not one to
       * start guessing about.
       */
      fileLog('[providers] cannot resolve a model for', agent.name, `(${resolvedPreset})`);
      next.push(agent);
      continue;
    }

    // Narrowed by the guard above; naming them settles it for the compiler
    // without a cast, which would only hide a future change to that guard.
    const finalPreset: string = resolvedPreset;
    const finalModel: string = resolvedModel;

    const filled = !presetId || !model;
    const updated: AgentRecord = filled
      ? { ...agent, presetId: finalPreset, model: finalModel }
      : agent;

    if (filled) {
      changed++;
      result.filled.push({
        id: agent.id,
        name: agent.name,
        presetId: resolvedPreset,
        model: resolvedModel,
      });
    }

    /*
     * Judged AFTER filling in, because the pairing that matters is the one
     * the agent will actually run with. An agent with a model and no
     * provider is not "fine until we look" — it was already pointing an
     * explicit model at an inherited host, which is the exact shape of the
     * failure.
     */
    const problem = checkModelPairing(finalPreset, finalModel);
    if (problem) {
      result.broken.push({
        id: agent.id,
        name: agent.name,
        presetId: resolvedPreset,
        model: resolvedModel,
        why: problem.message,
      });
    }

    next.push(updated);
  }

  // A rewrite that changes nothing is still a rewrite, and every write of
  // this file is a chance to lose the roster.
  if (changed > 0) {
    store.replaceAgents(next);
    fileLog('[providers] wrote an explicit provider and model onto', String(changed), 'agent(s)');
  }

  for (const bad of result.broken) {
    fileLog('[providers] unusable pairing:', bad.name, bad.presetId, bad.model);
  }

  return result;
}
