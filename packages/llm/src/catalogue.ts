/**
 * catalogue.ts — ask a provider what it can actually run.
 *
 * Every preset carries a short hand-picked model list, chosen by testing
 * which ones really return tool calls. That list is honest and badly
 * incomplete: NVIDIA offers **84** models and the preset named six, so the
 * dropdown hid most of what a key already paid for. Worse, a curated list
 * goes stale invisibly — the NVIDIA default was a model retired mid-project,
 * so a fresh install picked a broken one.
 *
 * Every provider here is OpenAI-compatible, and OpenAI-compatible means
 * `GET /v1/models`. So ask, and fall back to the curated list when there is
 * no key, no network, or an endpoint that does not implement it.
 */

export interface CatalogueEntry {
  id: string;
  /** True when this project has actually seen the model call a tool. */
  tested: boolean;
}

/** Models a provider reports, merged with the ones known to work here. */
export async function fetchModels(options: {
  baseUrl: string;
  apiKey?: string;
  curated: string[];
  timeoutMs?: number;
}): Promise<CatalogueEntry[]> {
  const curated = options.curated.map((id) => ({ id, tested: true }));

  if (!options.apiKey) return curated;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

    const res = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return curated;

    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (ids.length === 0) return curated;

    return mergeCatalogue(options.curated, ids);
  } catch {
    /*
     * A provider that cannot answer is not an error worth surfacing: the
     * curated list still works, and a model name can always be typed by
     * hand. Failing loudly here would turn "no network" into "cannot open
     * Settings".
     */
    return curated;
  }
}

/**
 * Tested models first, then everything else the provider offers.
 *
 * Order is the whole point. WispCrew is an agent, so a model that cannot
 * call tools is close to useless here — and several advertise support they
 * do not deliver (`llama-3.3-nemotron-super-49b` emitted a raw `<T` into its
 * reply instead of a tool call). Putting the verified ones at the top makes
 * the good choice the easy one without hiding the other seventy-eight.
 */
export function mergeCatalogue(curated: string[], reported: string[]): CatalogueEntry[] {
  const seen = new Set<string>();
  const out: CatalogueEntry[] = [];

  for (const id of curated) {
    // A curated model the provider no longer lists has been retired. Drop
    // it: offering it is how the stale default happened.
    if (reported.length > 0 && !reported.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, tested: true });
  }

  for (const id of [...reported].sort()) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, tested: false });
  }

  return out;
}
