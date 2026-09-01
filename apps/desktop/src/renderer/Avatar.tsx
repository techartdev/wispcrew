/**
 * Avatar.tsx — a small creature per agent, drawn from its id.
 *
 * ORIGINAL ARTWORK. The idea — every agent recognisable at a glance, a
 * group looking like a group — is a good one and plainly not unique to any
 * product. The shapes here are mine: a few ellipses and paths chosen so the
 * variants read as different at 30 pixels. Nothing is traced, copied or
 * derived from another application's assets (hard rule 1).
 *
 * Why not initials, which is what this replaced: two agents called "Local
 * Test" and "Local Infrastructure Eye" both render "LI"/"LT" — nearly the
 * same grey pill in the same place, and the roster is scanned far more
 * often than it is read. A shape and a colour are told apart in peripheral
 * vision; two letters are not.
 *
 * DETERMINISTIC. The same agent is the same creature on every machine and
 * after every restart, because the id is the seed. An avatar that changed
 * between launches would be worse than none — you would learn it twice.
 */
import { useMemo, type ReactElement } from 'react';

/**
 * A small, stable hash of the id.
 *
 * FNV-1a: a few lines, no dependency, and well spread for short strings —
 * which matters because ids share a long common prefix (`agent_`) and a
 * weaker hash would hand neighbouring agents the same face.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/*
 * Hues spaced around the wheel, skipping the muddy yellow-greens that read
 * as "washed out" on a dark background, and the reds reserved for danger —
 * an avatar that looks like a warning is a small lie told every time the
 * list is drawn.
 */
const HUES = [8, 28, 48, 145, 168, 190, 210, 232, 258, 282, 305, 330];

export interface AvatarLook {
  hue: number;
  /** Body silhouette. */
  shape: number;
  /** Eye treatment. */
  eyes: number;
  /** A mark on the body, for a little more variety. */
  mark: number;
}

export function lookFor(seed: string): AvatarLook {
  const h = hash(seed);
  return {
    hue: HUES[h % HUES.length]!,
    // Different bits for each trait, so two agents sharing a hue are very
    // unlikely to share a silhouette as well.
    shape: (h >>> 8) % 4,
    eyes: (h >>> 16) % 3,
    mark: (h >>> 24) % 3,
  };
}

/** The body outline, by variant. */
function body(shape: number): ReactElement {
  switch (shape) {
    // A tall bean.
    case 1:
      return <path d="M12 2c5 0 7.5 3.5 7.5 9S17 22 12 22 4.5 16.5 4.5 11 7 2 12 2Z" />;
    // A wide pebble.
    case 2:
      return <ellipse cx="12" cy="12.5" rx="9.5" ry="8" />;
    // A rounded square, softer than it sounds.
    case 3:
      return <rect x="3" y="3.5" width="18" height="17" rx="7" />;
    // A plain round one.
    default:
      return <circle cx="12" cy="12" r="9" />;
  }
}

/**
 * Eyes, which are what actually distinguish these at small sizes.
 *
 * They sit slightly high on the body: a face reads as a face when the eyes
 * are above the middle, and reads as a blob when they are centred.
 */
function eyes(variant: number, tone: string): ReactElement {
  switch (variant) {
    // Wide awake.
    case 1:
      return (
        <>
          <circle cx="9" cy="10.5" r="2.1" fill={tone} />
          <circle cx="15" cy="10.5" r="2.1" fill={tone} />
          <circle cx="9.6" cy="9.9" r="0.7" fill="rgba(255,255,255,0.9)" />
          <circle cx="15.6" cy="9.9" r="0.7" fill="rgba(255,255,255,0.9)" />
        </>
      );
    // Content, eyes closed.
    case 2:
      return (
        <>
          <path d="M7.2 10.8q1.8-2 3.6 0" stroke={tone} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M13.2 10.8q1.8-2 3.6 0" stroke={tone} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </>
      );
    // Small and attentive.
    default:
      return (
        <>
          <circle cx="9.2" cy="10.6" r="1.35" fill={tone} />
          <circle cx="14.8" cy="10.6" r="1.35" fill={tone} />
        </>
      );
  }
}

/** A small mark low on the body: an antenna, a stripe, or nothing. */
function mark(variant: number, tone: string): ReactElement | null {
  switch (variant) {
    case 1:
      return (
        <>
          <path d="M12 3.2V1.2" stroke={tone} strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="12" cy="0.9" r="1.1" fill={tone} />
        </>
      );
    case 2:
      return <path d="M8.6 16.2q3.4 2 6.8 0" stroke={tone} strokeWidth="1.4" fill="none" strokeLinecap="round" />;
    default:
      return null;
  }
}

export interface AvatarProps {
  /** Stable seed — the agent id, never its name, which the user may edit. */
  seed: string;
  size?: number;
  /**
   * Whether this agent is doing something.
   *
   * Drives a slow breathing motion, which is the honest version of a
   * "typing" indicator: it says the agent is occupied without claiming to
   * know that words are being produced.
   */
  busy?: boolean;
  title?: string;
}

export function Avatar({ seed, size = 30, busy = false, title }: AvatarProps) {
  const look = useMemo(() => lookFor(seed), [seed]);

  const fill = `hsl(${look.hue} 62% 58%)`;
  const shade = `hsl(${look.hue} 55% 44%)`;
  // Ink dark enough to read on any of the body colours above.
  const tone = `hsl(${look.hue} 70% 14%)`;

  return (
    <svg
      className={`avatar${busy ? ' avatar-busy' : ''}`}
      width={size}
      height={size}
      viewBox="-1 -1 26 26"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        {/* Lit from above, so the shape reads as solid rather than flat. */}
        <linearGradient id={`g${look.hue}-${look.shape}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} />
          <stop offset="100%" stopColor={shade} />
        </linearGradient>
      </defs>

      <g fill={`url(#g${look.hue}-${look.shape})`}>{body(look.shape)}</g>
      {mark(look.mark, fill)}
      {eyes(look.eyes, tone)}
    </svg>
  );
}

/**
 * Several agents as one avatar, for a shared room.
 *
 * Overlapped rather than shrunk into a grid: at this size a two-by-two of
 * quarter-sized creatures is four smudges, while two overlapping ones still
 * read as two, and as "more than one" even when they do not.
 *
 * Capped at three. A fourth adds nothing legible and only makes the stack
 * wider than the row it sits in.
 */
export function AvatarStack({
  seeds,
  size = 30,
  busy = false,
  title,
}: {
  seeds: string[];
  size?: number;
  busy?: boolean;
  title?: string;
}) {
  const shown = seeds.slice(0, 3);

  if (shown.length <= 1) {
    return <Avatar seed={shown[0] ?? 'empty'} size={size} busy={busy} title={title} />;
  }

  // Each one a little smaller, so the group occupies the same room as a
  // single avatar and the list stays on one rhythm.
  const each = Math.round(size * 0.72);
  const step = Math.round((size - each) / (shown.length - 1));

  return (
    <span
      className="avatar-stack"
      style={{ width: size, height: size }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {shown.map((seed, i) => (
        <span
          key={seed}
          className="avatar-stack-item"
          style={{ left: i * step, top: i * step, zIndex: shown.length - i }}
        >
          <Avatar seed={seed} size={each} busy={busy && i === 0} />
        </span>
      ))}
    </span>
  );
}
