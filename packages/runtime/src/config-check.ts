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
import { PROVIDER_PRESETS } from '@wispcrew/llm';
import { describeModelMismatch, servesAnyName } from '@wispcrew/shared';
import { listCachedModels } from './model-catalogue.js';

export interface ConfigProblem {
  /** Shown to the user, and written into the conversation. */
  message: string;
}

/**
 * Whether this provider may serve a model under any name.
 *
 * Delegated to `shared` so the renderer, the daemon and the engine judge
 * from one implementation. The rule is subtle — ownership, not absence —
 * and a second copy would get it wrong somewhere nobody was looking.
 */
function anythingGoes(presetId: string): boolean {
  return servesAnyName(PROVIDER_PRESETS.find((p) => p.id === presetId));
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

  const trimmedModel = model.trim();

  /*
   * Does another vendor claim this name?
   *
   * Checked FIRST because it needs nothing: no network, no cache, no
   * previous turn. The catalogue arm below could only judge a provider this
   * process had already fetched a list from, which on a freshly started
   * daemon is none of them — so the case this whole file was written for
   * sailed straight through. An agent on NVIDIA set to `gpt-5.6-terra` ran
   * its full retry schedule against a host that answers `404 page not
   * found`, in a room where other agents were spending real tokens waiting
   * for it.
   */
  const mismatch = describeModelMismatch(PROVIDER_PRESETS, presetId, trimmedModel);
  if (mismatch) return { message: `${mismatch} Nothing was sent.` };

  /*
   * Only a catalogue this process has actually fetched counts.
   *
   * Never fetched means never judged: a first turn must not be blocked by
   * a network call, and a provider that could not be reached tells us
   * nothing about whether its model list contains this name.
   */
  const known = listCachedModels(presetId);
  if (!known || known.length === 0) return null;

  if (known.some((m) => m.id === trimmedModel)) return null;
  // A local or proxied endpoint may serve anything under any name, so its
  // catalogue is not authoritative about what it will answer to.
  if (anythingGoes(presetId)) return null;

  /*
   * A custom or self-hosted endpoint may serve anything. The catalogue is
   * only authoritative for a provider that publishes one, so this refuses
   * only when the provider both published a list and left this model off
   * it.
   */
  return {
    message:
      `This agent is set to the model "${trimmedModel}", which ${presetId} does not offer. ` +
      'That request cannot succeed, so it was not sent. ' +
      'Open Configure and pick a model from this provider, or change the provider to match.',
  };
}
