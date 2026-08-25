/**
 * node-tls.ts — transport security for a node reachable over a network.
 *
 * A local socket is protected by filesystem permissions. A network listener
 * has none of that, so it gets TLS: the traffic carries a token that grants
 * shell access, and it must not cross a LAN in the clear.
 *
 * ## Self-signed, pinned on first pair
 *
 * There is no certificate authority here, and there should not be. A user
 * pairing their own Raspberry Pi cannot obtain a public certificate for it,
 * and requiring one would push people to disable verification entirely —
 * which is worse than no TLS at all, because it looks secure.
 *
 * Instead each node generates a long-lived self-signed certificate and the
 * client records its fingerprint when pairing. Later connections must
 * present the *same* certificate. That is the same trust model as SSH known
 * hosts: unauthenticated the first time, pinned thereafter, and loud when it
 * changes.
 *
 * ## Why the certificate is generated with Node's own crypto
 *
 * Shelling out to `openssl` would be simpler and is not available
 * everywhere — notably a stock Windows machine. `node:crypto` can generate
 * the key pair, and the certificate is assembled by hand below. It is a
 * small amount of DER, and it removes a runtime dependency from a security
 * path.
 */
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CERT_FILE = 'node-cert.pem';
const KEY_FILE = 'node-tls-key.pem';

export interface NodeIdentity {
  cert: string;
  key: string;
  /** SHA-256 of the DER certificate, formatted like OpenSSL prints it. */
  fingerprint: string;
}

/* ------------------------------------------------------------------ */
/* Minimal DER encoding                                                */
/* ------------------------------------------------------------------ */

/** Wrap a payload in a DER tag/length header. */
function der(tag: number, body: Buffer): Buffer {
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const len = [];
  let n = body.length;
  while (n > 0) {
    len.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | len.length, ...len]), body]);
}

const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
const set = (body: Buffer) => der(0x31, body);
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const utf8 = (s: string) => der(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (body: Buffer) => der(0x04, body);

/** Positive INTEGER, with a leading zero when the high bit would sign it. */
function int(value: Buffer | number): Buffer {
  let body = typeof value === 'number' ? Buffer.from([value]) : value;
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
}

/** BIT STRING with no unused bits. */
const bits = (body: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), body]));

/** `YYMMDDHHMMSSZ`, which is what UTCTime wants for years before 2050. */
function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const text =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

/** A Name containing a single CN. */
function commonName(name: string): Buffer {
  return seq(set(seq(oid([0x55, 0x04, 0x03]), utf8(name))));
}

/**
 * subjectAltName.
 *
 * Modern TLS stacks ignore CN entirely, so a certificate without SANs fails
 * verification even when the name matches. Both DNS and IP forms are
 * included because a node is commonly reached by address.
 */
function subjectAltName(names: string[]): Buffer {
  const entries = names.map((n) => {
    const asIpv4 = n.split('.');
    const isIpv4 =
      asIpv4.length === 4 && asIpv4.every((o) => /^\d+$/.test(o) && Number(o) <= 255);
    // [2] dNSName, [7] iPAddress — context-specific, primitive.
    return isIpv4
      ? der(0x87, Buffer.from(asIpv4.map(Number)))
      : der(0x82, Buffer.from(n, 'ascii'));
  });
  return seq(
    oid([0x55, 0x1d, 0x11]),
    octet(seq(...entries)),
  );
}

/**
 * Generate a self-signed certificate for this node.
 *
 * Valid for ten years: a node is paired once and expected to keep working.
 * An expiring certificate would break the pin for no security benefit, since
 * trust here comes from the fingerprint rather than from a chain.
 */
export function generateSelfSigned(hostnames: string[]): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const name = commonName(hostnames[0] ?? 'wispcrew-node');
  const now = new Date();
  const until = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);

  // sha256WithRSAEncryption
  const sigAlg = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05, Buffer.alloc(0)));

  /*
   * X.509 v3 extensions: `[3] EXPLICIT SEQUENCE OF Extension`.
   *
   * Exactly two levels — the context tag, then one SEQUENCE holding the
   * extensions. An earlier version nested a third SEQUENCE inside, which
   * OpenSSL rejected with a bare "wrong tag" and no indication of where.
   */
  const extensions = der(
    0xa3,
    seq(
      // basicConstraints: not a CA.
      seq(oid([0x55, 0x1d, 0x13]), octet(seq(bool(false)))),
      subjectAltName(hostnames),
    ),
  );

  const tbs = seq(
    der(0xa0, int(2)), // version v3
    int(Buffer.from(createHash('sha256').update(hostnames.join(',') + now.toISOString()).digest().subarray(0, 8))),
    sigAlg,
    name, // issuer == subject
    seq(utcTime(now), utcTime(until)),
    name,
    Buffer.from(publicKey),
    extensions,
  );

  const signature = createSign('sha256').update(tbs).sign(privateKey);
  const cert = seq(tbs, sigAlg, bits(signature));

  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    (cert.toString('base64').match(/.{1,64}/g) ?? []).join('\n') +
    '\n-----END CERTIFICATE-----\n';

  return { cert: pem, key: privateKey, fingerprint: fingerprintOf(cert) };
}

/** SHA-256 fingerprint, colon-separated uppercase hex — as tools display it. */
export function fingerprintOf(der: Buffer): string {
  return (
    createHash('sha256')
      .update(der)
      .digest('hex')
      .toUpperCase()
      .match(/.{2}/g) ?? []
  ).join(':');
}

/** Fingerprint of a PEM certificate. */
export function fingerprintOfPem(pem: string): string {
  const base64 = pem
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  return fingerprintOf(Buffer.from(base64, 'base64'));
}

/**
 * Load this node's TLS identity, generating it on first use.
 *
 * The private key is written 0600 before any content reaches it, for the
 * same reason as the token file: creating it readable and tightening it
 * afterwards leaves a window where it is not.
 */
export function loadOrCreateIdentity(dataDir: string, hostnames: string[]): NodeIdentity {
  const certPath = path.join(dataDir, CERT_FILE);
  const keyPath = path.join(dataDir, KEY_FILE);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    return { cert, key: fs.readFileSync(keyPath, 'utf8'), fingerprint: fingerprintOfPem(cert) };
  }

  const identity = generateSelfSigned(hostnames);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, identity.key, { mode: 0o600 });
  fs.writeFileSync(certPath, identity.cert, { mode: 0o644 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* not POSIX */
  }
  return identity;
}
