/**
 * Fetching a URL that came from a request body (SSRF guard).
 *
 * The server must never fetch internal addresses on a user's behalf: loopback,
 * private networks, link-local (cloud metadata at 169.254.169.254) and similar.
 * A string check on the hostname is not enough, because any public name can
 * resolve to a private IP, so the name is resolved and EVERY returned address
 * is checked. Only http/https on the default ports are allowed.
 *
 * Residual risk: fetch() resolves the name again when it connects, so a DNS
 * server that answers differently the second time (DNS rebinding) could still
 * slip through. Redirects are followed by hand and each hop is re-checked.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

// Two lists: Node matches IPv4 against IPv4-mapped IPv6 rules, so one shared list would block all of IPv4.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96], // IPv4-mapped: may wrap a private IPv4
  ["64:ff9b::", 96], // NAT64: may wrap a private IPv4
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4: may wrap a private IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** True for any address the server must not connect to (also for garbage input). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blockedV4.check(ip, "ipv4");
  if (family === 6) return blockedV6.check(ip, "ipv6");
  return true;
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Throws unless `raw` is an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw: unknown, lookup: LookupFn = defaultLookup): Promise<URL> {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("invalid url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme not allowed");
  if (!ALLOWED_PORTS.has(url.port)) throw new Error("port not allowed");
  if (url.username || url.password) throw new Error("credentials not allowed");

  // URL keeps IPv6 literals in brackets; URL also normalises 2130706433 / 0x7f.1 to dotted IPv4.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("invalid url");

  const addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new Error("address not allowed");
  }
  return url;
}

/** Reads at most `maxBytes` of the body, then stops downloading. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches a user-supplied page and returns its visible text, at most `maxChars`.
 * Throws on a blocked address, a bad redirect, or a timeout.
 */
export async function fetchPublicText(
  raw: string,
  { maxChars = 5000, maxBytes = 1_000_000, timeoutMs = 10_000, maxRedirects = 5 } = {},
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = await assertPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HermyHQ/1.0)" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new Error("too many redirects");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    return htmlToText(await readCapped(res, maxBytes)).slice(0, maxChars);
  }
}
