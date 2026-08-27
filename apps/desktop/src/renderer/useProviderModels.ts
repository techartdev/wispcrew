/**
 * useProviderModels.ts — every model a provider offers, not only ours.
 *
 * The preset carries six models chosen by testing whether they really return
 * tool calls. NVIDIA alone offers **84**, so the dropdown was hiding most of
 * what a key already paid for — and a hand-written list goes stale
 * invisibly: the NVIDIA default was a model retired mid-project, so a fresh
 * install picked one that answered 410 Gone.
 *
 * The tested ones stay at the top, because WispCrew is an agent and a model
 * that cannot call a tool is close to useless here. The rest follow, because
 * they are the user's to choose.
 */
import { useEffect, useState } from 'react';

export interface ModelChoice {
  id: string;
  /** Seen calling a tool in this project, not merely advertised. */
  tested: boolean;
}

export function useProviderModels(presetId: string | undefined, fallback: string[]): ModelChoice[] {
  const [models, setModels] = useState<ModelChoice[]>(() =>
    fallback.map((id) => ({ id, tested: true })),
  );

  useEffect(() => {
    if (!presetId) return;

    let cancelled = false;

    // The fallback shows immediately, so the field is never empty while the
    // provider is being asked.
    setModels(fallback.map((id) => ({ id, tested: true })));

    void window.wispcrew
      .listProviderModels(presetId)
      .then((list) => {
        if (!cancelled && list.length > 0) setModels(list);
      })
      .catch(() => {
        /*
         * A provider that cannot answer is not worth an error: the curated
         * list still works and a model name can always be typed by hand.
         * Failing loudly would turn "no network" into "cannot open
         * Settings".
         */
      });

    return () => {
      cancelled = true;
    };
    // `fallback` is a fresh array each render; keying on its contents keeps
    // this from re-fetching forever.
  }, [presetId, fallback.join(',')]);

  return models;
}
