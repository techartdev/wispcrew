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
import { describeModelMismatch } from '@wispcrew/shared';

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
   * And that is the only thing refused here.
   *
   * There used to be a second arm: if this process had fetched the
   * provider's catalogue and the model was not on it, the turn was blocked.
   * That is ABSENCE again — the exact reasoning `model-pairing.ts` exists to
   * reject — merely with a fresher list, and it was wrong for two ordinary
   * cases:
   *
   *  - **A model released this week.** Reported on `gpt-6-astra` while it
   *    was rolling out: "astra is a model currently releasing, I don't want
   *    to be stopped from trying to call it."
   *  - **An older model still served but no longer advertised.** Vendors
   *    keep answering to deprecated names long after dropping them from the
   *    list, and those names work.
   *
   * A catalogue says what a provider ADVERTISES, not what it will answer
   * to. Refusing on it made this app's release cadence the limit on which
   * models a user could try, which is the thing the ownership rule was
   * written to avoid.
   *
   * So an unrecognised model is now SENT, and the provider's own error
   * comes back if it was wrong — `describeHttpError` already extracts the
   * API's message and quotes it. The case this file was written for is
   * still caught, because it is a positive claim rather than a silence: an
   * agent on NVIDIA set to `gpt-5.6-terra` is refused above, before any
   * network call, by the ownership check.
   */
  return null;
}
