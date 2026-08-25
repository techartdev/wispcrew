/**
 * pairing.ts — attaching a node you own, without an account.
 *
 * The flow, deliberately shaped like pairing a device rather than logging in
 * to a service:
 *
 *   1. On the node:   `ghostbot serve --listen --pair`
 *                     prints a short code and the certificate fingerprint.
 *   2. In the client: add a node, enter host and code.
 *   3. The two exchange the code for a long-lived per-node token over TLS,
 *      and the client pins the fingerprint it saw.
 *
 * No GhostBot server is involved at any point. It works on a LAN with the
 * internet down, and there is nothing to sign up for.
 *
 * ## Why a short code and not the token itself
 *
 * The token grants shell access for as long as it exists, so it must not be
 * something a user reads aloud, pastes into a chat window, or leaves in
 * shell history. The pairing code is single-use and expires in minutes: if
 * it leaks afterwards it is worthless, and while it is live an attacker must
 * also reach the node's port.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a pairing code stays valid. Long enough to type, short enough to matter. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * Characters used for pairing codes.
 *
 * No 0/O or 1/I/L: the code is read off one screen and typed into another,
 * often from a terminal font to a GUI one, and a user should never have to
 * wonder which character they are looking at.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface PairingOffer {
  code: string;
  expiresAt: number;
  fingerprint: string;
}

/** A code like `K7M2-9QXP-4RTB`: 15 bits per group, 45 bits total. */
export function generatePairingCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** Compare codes without leaking how much of one was right. */
export function codesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const bufA = Buffer.from(norm(a), 'utf8');
  const bufB = Buffer.from(norm(b), 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * A pairing window on the node.
 *
 * Single-use by construction: `claim` consumes the offer whether or not the
 * code was right. A code that can be guessed repeatedly is a code that can
 * be brute-forced, and 45 bits only helps if there is one attempt.
 */
export class PairingWindow {
  private offer: (PairingOffer & { token: string }) | null = null;

  /** Open a window, returning what the node should display. */
  open(fingerprint: string, token: string): PairingOffer {
    const code = generatePairingCode();
    this.offer = {
      code,
      token,
      fingerprint,
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    return { code, fingerprint, expiresAt: this.offer.expiresAt };
  }

  get isOpen(): boolean {
    return this.offer !== null && Date.now() < this.offer.expiresAt;
  }

  get expiresAt(): number | null {
    return this.offer?.expiresAt ?? null;
  }

  /**
   * Exchange a code for the node's token.
   *
   * Returns null for a wrong or expired code, and the offer is consumed
   * either way. The caller reports one message for both cases: telling an
   * attacker whether a code was *valid but expired* narrows their search.
   */
  claim(code: string): string | null {
    const offer = this.offer;
    this.offer = null;
    if (!offer) return null;
    if (Date.now() >= offer.expiresAt) return null;
    if (!codesMatch(code, offer.code)) return null;
    return offer.token;
  }

  close(): void {
    this.offer = null;
  }
}

/** A node a client has paired with. */
export interface PairedNode {
  id: string;
  name: string;
  /** `host:port`, as the user typed it. */
  address: string;
  token: string;
  /** Pinned at pairing; a change means a different machine or a MITM. */
  fingerprint: string;
  pairedAt: number;
  lastSeenAt?: number;
}

/**
 * Does this certificate match what we pinned?
 *
 * Compared case-insensitively and without separators, because different
 * tools format fingerprints differently and a user may retype one.
 */
export function fingerprintMatches(pinned: string, presented: string): boolean {
  const norm = (s: string) => s.replace(/[^a-f0-9]/gi, '').toLowerCase();
  const a = Buffer.from(norm(pinned), 'utf8');
  const b = Buffer.from(norm(presented), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
