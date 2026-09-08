/**
 * private-address.ts — is this host on the inside?
 *
 * `web_fetch` is a SAFE tool: it runs without an approval card, on the
 * reasoning that reading a public web page is not a dangerous act. That
 * reasoning holds only for genuinely PUBLIC addresses.
 *
 * It validated the protocol and nothing else, so an agent could fetch:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *   http://127.0.0.1:8787/            (the node's own protocol port)
 *   http://192.168.1.1/               (anything on the home network)
 *
 * — with no card and no record beyond the transcript. Worst on exactly the
 * deployment this project encourages: an agent on a VPS, where the metadata
 * service hands out cloud credentials to anything that asks.
 *
 * Found by an agent reviewing this repository, which also noted that
 * `readonly` policy does not help: that only denies calls which need
 * approval, and this one never did.
 *
 * ## What this is and is not
 *
 * This resolves a hostname and refuses the request when any address it
 * resolves to is not public. It is checked again after every redirect,
 * because a public URL that redirects to `169.254.169.254` is the obvious
 * way around a check performed once.
 *
 * It is NOT protection against DNS rebinding — a name that resolves
 * differently between our check and the connection. Closing that needs the
 * request to be made to the address we validated, which the fetch API does
 * not expose. Stated rather than glossed: this raises the cost from
 * "trivial" to "requires a rebinding attack".
 */
import { lookup } from 'node:dns/promises';

/** Split an IPv4 string into octets, or undefined if it is not IPv4. */
function octets(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;

  const values = parts.map((p) => Number(p));
  return values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? values : undefined;
}

/**
 * True for any address that is not routable on the public internet.
 *
 * Deliberately generous: every range here is either unroutable, reserved, or
 * somebody's private network, and a false refusal costs one explanation
 * while a false allow costs a credential.
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // IPv6, including the mapped forms that carry an IPv4 address inside.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    // Unique-local fc00::/7 and link-local fe80::/10.
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;

    const mapped = host.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }

  const ip = octets(host);
  if (!ip) return false;

  const [a, b] = ip as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a >= 224) return true; // multicast and reserved, incl. 255.255.255.255

  return false;
}

/**
 * Refuse a URL whose host resolves anywhere private.
 *
 * Returns a reason to show the model, or undefined when the address is
 * public. The reason names the resolved address, because "blocked" without
 * a why invites the model to retry the same URL.
 */
export async function refuseIfPrivate(url: URL): Promise<string | undefined> {
  const host = url.hostname;

  // A literal address needs no lookup, and passing one to the resolver is
  // how an IPv6 literal ends up mis-parsed.
  if (isPrivateAddress(host)) {
    return `${host} is a private or loopback address. web_fetch reaches public sites only.`;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    // A name that does not resolve is the fetch's problem to report, with a
    // better message than this one could give.
    return undefined;
  }

  const blocked = resolved.find((r) => isPrivateAddress(r.address));
  if (blocked) {
    return (
      `${host} resolves to ${blocked.address}, which is a private or loopback ` +
      'address. web_fetch reaches public sites only, so it cannot be used to ' +
      'read this machine, the local network, or a cloud metadata service.'
    );
  }

  return undefined;
}
