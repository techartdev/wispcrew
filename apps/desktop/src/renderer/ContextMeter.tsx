/**
 * ContextMeter.tsx — how full the conversation's context is.
 *
 * The whole transcript is rebuilt and sent on every turn, so a long
 * conversation grows until the provider refuses it. Until now nothing said
 * so: the first sign was a wall of provider JSON on a turn that had worked
 * an hour earlier. This is the part that lets somebody see it coming.
 *
 * ## What it does not do
 *
 * It never invents a denominator. When this build does not know the model's
 * context window there is no percentage and no bar — just the amount used —
 * because a wrong limit produces either false alarm or false confidence,
 * and both get acted on. The same rule the subscription code follows for
 * Anthropic usage, where the provider reports no figure and the UI says so.
 *
 * And it distinguishes a measurement from an estimate. Before the first
 * turn there is only a character-count estimate; afterwards the provider's
 * own input-token figure is used. "~" is the difference, and the tooltip
 * spells it out.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextReportView } from '@wispcrew/shared';

/** The breakdown's size, needed before it exists in order to place it. */
const PANEL_W = 260;
const PANEL_H = 230;
/** Keep this far from every window edge. */
const MARGIN = 8;

/** `12345` → `12.3K`, because the exact digit is never the question. */
function short(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * How alarming to look.
 *
 * Three bands rather than a gradient: a colour that changes continuously
 * says nothing at a glance, and the only decisions available are "carry on"
 * and "do something about it".
 */
function tone(fraction: number | undefined): string {
  if (fraction === undefined) return '';
  if (fraction >= 0.9) return ' context-meter-full';
  if (fraction >= 0.7) return ' context-meter-warm';
  return '';
}

export function ContextMeter({
  report,
  onCompact,
  inline = false,
}: {
  report: ContextReportView | null;
  /** Replace the older turns with a summary. Absent while one is running. */
  onCompact?: () => void;
  /**
   * Rendered inside the room panel rather than under the composer.
   *
   * Affects only how the TRIGGER looks — the panel is about two hundred
   * pixels wide, so the meter fills its own line and wears its border only
   * on hover. The breakdown itself is identical in both places.
   */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  /**
   * Where the breakdown should appear, in viewport coordinates.
   *
   * Measured from the trigger and clamped to the window. Prefers to open
   * upwards, because both meters sit low — under the composer, and near the
   * bottom of a member list — and falls below only when there is no room
   * above.
   */
  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;

    const room = { above: rect.top - MARGIN, below: window.innerHeight - rect.bottom - MARGIN };

    setAt({
      top: room.above >= PANEL_H || room.above >= room.below
        ? Math.max(MARGIN, rect.top - PANEL_H - 6)
        : rect.bottom + 6,
      // Right-aligned with the trigger, then pulled back inside the window.
      left: Math.min(
        Math.max(MARGIN, rect.right - PANEL_W),
        window.innerWidth - PANEL_W - MARGIN,
      ),
    });
  };

  /*
   * Close on anything that would move the trigger out from under it.
   *
   * A panel positioned once and left there drifts away from the control it
   * belongs to the moment the pane scrolls. Closing is honest and cheap;
   * following the trigger would mean recomputing on every scroll frame for
   * a panel nobody keeps open.
   */
  useEffect(() => {
    if (!open) return;

    const shut = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    // `true` so a scroll inside the room pane is caught too: scroll does not
    // bubble, and the pane is the container this most needs to hear from.
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing measured yet, or an empty conversation: say nothing rather than
  // showing a confident zero.
  if (!report || report.used <= 0) return null;

  const pct = report.fraction !== undefined ? Math.round(report.fraction * 100) : undefined;
  const approx = report.measured ? '' : '~';

  const label =
    pct !== undefined
      ? `${pct}% of context`
      : `${approx}${short(report.used)} tokens`;

  const title = report.measured
    ? `Reported by the provider for the last turn${report.model ? ` (${report.model})` : ''}.`
    : 'Estimated from the text — no turn has run yet, so the provider has not reported a figure.';

  return (
    <div className={`context-meter-wrap${inline ? ' context-meter-inline' : ''}`}>
      <button
        type="button"
        ref={trigger}
        className={`context-meter${tone(report.fraction)}`}
        onClick={() => {
          if (!open) place();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={title}
      >
        {/*
          The bar only appears with a known limit. A bar with no denominator
          would have to pick a width, and any width it picked would be a
          claim about how full the context is.
        */}
        {report.fraction !== undefined && (
          <span className="context-meter-track" aria-hidden="true">
            <span
              className="context-meter-fill"
              style={{ width: `${Math.max(report.fraction * 100, 2)}%` }}
            />
          </span>
        )}
        <span className="context-meter-label">{label}</span>
      </button>

      {/*
        Rendered into the document body, not beside the trigger.
        
        The room panel scrolls, and `overflow-y: auto` makes a clipping
        context: an absolutely-positioned child of it CANNOT leave it, no
        matter how it is anchored. Two attempts at anchoring failed for that
        reason, and the panel came out cut off against the window edge.
        
        A portal takes it out of that box entirely, and `position: fixed`
        with a measured, clamped position keeps it on screen wherever the
        trigger happens to be.
      */}
      {open && at && createPortal(
        <div
          className="context-breakdown"
          role="dialog"
          aria-label="Context usage"
          style={{ position: 'fixed', top: at.top, left: at.left, width: PANEL_W }}
        >
          <div className="context-breakdown-head">
            <strong>
              {approx}
              {short(report.used)}
              {report.limit ? ` / ${short(report.limit)}` : ''}
            </strong>
            <span className="muted small">
              {report.measured ? 'reported by the provider' : 'estimated'}
            </span>
          </div>

          {/*
            The parts are always estimated, even when the total is measured:
            a provider reports one number and never says which part of it
            was the tools. Said plainly rather than implied by a tilde.
          */}
          <ul className="context-breakdown-list">
            <li>
              <span className="context-dot context-dot-system" aria-hidden="true" />
              System prompt
              <em>~{short(report.systemTokens)}</em>
            </li>
            <li>
              <span className="context-dot context-dot-tools" aria-hidden="true" />
              Tools
              <em>~{short(report.toolTokens)}</em>
            </li>
            <li>
              <span className="context-dot context-dot-messages" aria-hidden="true" />
              Messages
              <em>~{short(report.messageTokens)}</em>
            </li>
          </ul>

          <p className="muted small context-breakdown-note">
            {report.limit
              ? 'The whole conversation is sent every turn. When it no longer fits, the provider refuses it.'
              : `No context size is known for ${report.model ?? 'this model'}, so there is no percentage. Set one in Configure if you know it.`}
            {report.agentName ? ` Measured for ${report.agentName}.` : ''}
          </p>

          {onCompact && (
            <div className="context-breakdown-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  // Left open: the result is a toast, and closing the panel
                  // underneath somebody's click reads as the button failing.
                  void Promise.resolve(onCompact()).finally(() => setBusy(false));
                }}
              >
                {busy ? 'Compacting…' : 'Compact now'}
              </button>
              {/*
                Said before it is pressed, not after. This rewrites the
                conversation, and "it is recoverable" is the fact that makes
                the button safe to try.
              */}
              <span className="muted small">
                Replaces older turns with a summary. The full version stays in History.
              </span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
