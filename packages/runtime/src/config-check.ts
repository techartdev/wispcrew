/**
 * config-check.ts — refuse a turn that cannot possibly work.
 *
 * An agent created through the CLI ended up with its provider inherited
 * (NVIDIA) and its model set to `gpt-5.6-terra`, which is OpenAI's. Every
 * turn it ran was a request NVIDIA answers 404 to and always will — retried,
 * then reported as a provider error, in a room where other agents were
 * spending real tokens waiting for it.
 *
 * The complaint was exact: "when an agent is defective I need to get an
 * error about the problem, not waste everyone else's tokens for obvious
 * failure."
 *
 * So this runs BEFORE the provider is called. It is deliberately narrow:
 * it reports only what is KNOWN to be wrong, never what merely looks
 * unusual. A local endpoint serving a model under any name it likes must
 * keep working, and a catalogue this process has not fetched proves
 * nothing.
 */
import { listCachedModels } from './model-catalogue.js';

export interface ConfigProblem {
  /** Shown to the user, and written into the conversation. */
  message: string;
}

/**
 * Is this agent's provider and model pairing known to be impossible?
 *
 * Returns null when it cannot tell, which is most of the time and is the
 * correct answer — a guess here would block a working configuration, and
 * that is far worse than the failure it prevents.
 */
export function checkModelPairing(
  presetId: string | undefined,
  model: string | undefined,
): ConfigProblem | null {
  if (!presetId || !model) return null;

  /*
   * Only a catalogue this process has actually fetched counts.
   *
   * Never fetched means never judged: a first turn must not be blocked by
   * a network call, and a provider that could not be reached tells us
   * nothing about whether its model list contains this name.
   */
  const known = listCachedModels(presetId);
  if (!known || known.length === 0) return null;

  const trimmed = model.trim();
  if (known.some((m) => m.id === trimmed)) return null;

  /*
   * A custom or self-hosted endpoint may serve anything. The catalogue is
   * only authoritative for a provider that publishes one, so this refuses
   * only when the provider both published a list and left this model off
   * it.
   */
  return {
    message:
      `This agent is set to the model "${trimmed}", which ${presetId} does not offer. ` +
      'That request cannot succeed, so it was not sent. ' +
      'Open Configure and pick a model from this provider, or change the provider to match.',
  };
}
