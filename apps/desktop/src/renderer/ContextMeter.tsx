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
import { useState } from 'react';
import type { ContextReportView } from '@wispcrew/shared';

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

export function ContextMeter({ report }: { report: ContextReportView | null }) {
  const [open, setOpen] = useState(false);

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
    <div className="context-meter-wrap">
      <button
        type="button"
        className={`context-meter${tone(report.fraction)}`}
        onClick={() => setOpen((v) => !v)}
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

      {open && (
        <div className="context-breakdown" role="dialog" aria-label="Context usage">
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
        </div>
      )}
    </div>
  );
}
