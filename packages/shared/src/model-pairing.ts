/**
 * model-pairing.ts — is this model this provider's to serve?
 *
 * Lives in `shared` because the answer is needed in three places that
 * cannot import each other: the engine before a turn, the daemon before it
 * saves an agent, and the renderer while somebody is still typing. Writing
 * it three times is how three answers drift, and this rule is subtle enough
 * that a second copy would get it wrong.
 *
 * It takes the preset list as an argument rather than importing one, which
 * is what lets the sandboxed renderer use it: the renderer already receives
 * the same list over IPC, so both callers judge from identical data.
 *
 * ## The distinction the whole rule rests on
 *
 * "Not in my provider's list" proves NOTHING. Those lists are curated and
 * short — NVIDIA serves 84 models and its preset names six — and a model
 * released this week is in none of them. Refusing on absence would make
 * every provider update a release of this app.
 *
 * "Listed by a DIFFERENT vendor, and not by mine" is a positive claim of
 * ownership by somebody else. That is the only thing this reports, and it
 * is enough: asking NVIDIA for `gpt-5.6-terra` returns `404 page not found`
 * and always will.
 */

/** The little that is needed of a provider preset to judge a pairing. */
export interface PairingPreset {
  id: string;
  label?: string;
  models?: string[];
  /** True for a local endpoint, which may serve anything under any name. */
  local?: boolean;
}

/**
 * Providers that may serve a model under any name they like.
 *
 * A local server or a proxy can call its model anything — `local-model`, or
 * somebody's own alias for a hosted one — so no name proves anything here,
 * in either direction. These are never judged, and never used as evidence
 * against anybody else.
 */
export function servesAnyName(preset: PairingPreset | undefined): boolean {
  return Boolean(preset?.local) || preset?.id === 'custom';
}

/**
 * Which OTHER providers in this list explicitly claim this model name.
 *
 * Empty means "no opinion", which is the common and correct answer: an
 * unknown name, a local endpoint, or a model the agent's own provider
 * already lists.
 */
export function modelClaimedBy(
  presets: PairingPreset[],
  presetId: string | undefined,
  model: string | undefined,
): string[] {
  const name = model?.trim();
  if (!presetId || !name) return [];

  const mine = presets.find((p) => p.id === presetId);
  if (!mine || servesAnyName(mine)) return [];

  /*
   * Mine lists it: settled, whatever anyone else says.
   *
   * Two providers can legitimately serve the same name — an OpenAI model
   * through a subscription and through the API is the obvious case, and
   * treating that as a conflict would condemn a correct configuration.
   */
  if ((mine.models ?? []).includes(name)) return [];

  return presets
    .filter((p) => p.id !== presetId && !servesAnyName(p) && (p.models ?? []).includes(name))
    .map((p) => p.label ?? p.id);
}

/**
 * The sentence to show when a pairing cannot work, or null.
 *
 * Names the owner rather than saying "not offered": "belongs to OpenAI"
 * tells somebody what they actually did, where "this provider does not
 * offer it" sends them hunting through a list.
 */
export function describeModelMismatch(
  presets: PairingPreset[],
  presetId: string | undefined,
  model: string | undefined,
): string | null {
  const owners = modelClaimedBy(presets, presetId, model);
  if (owners.length === 0) return null;

  return (
    `"${model?.trim()}" belongs to ${owners.join(' / ')}, not to ${presetId}. ` +
    'That request cannot succeed. Pick a model this provider serves, or switch the ' +
    'provider to match the model.'
  );
}
