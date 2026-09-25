import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");
const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");

export const CRAWL_LIMITS = {
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxResponseBytes: 2_000_000,
} as const;

type Address = { address: string; family: 4 | 6 };
export type DnsResolver = (hostname: string) => Promise<Address[]>;

const defaultResolver: DnsResolver = async (hostname) =>
  (await lookup(hostname, { all: true, order: "verbatim" })).map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new Error("Crawler DNS address family mismatch");
    return { address, family };
  });

export function validatePublicUrl(value: string): URL {
  if (!/^https?:\/\//i.test(value) || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  })) {
    throw new Error("Crawler URL must be an absolute HTTP or HTTPS URL");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Crawler URL scheme is not allowed");
  }
  if (url.port) throw new Error("Crawler URL port is not allowed");
  if (url.username || url.password) throw new Error("Crawler URL credentials are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) === 0) {
    const labels = hostname.replace(/\.$/, "").split(".");
    if (
      labels.length < 2 ||
      labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      ["localhost", "local", "internal", "lan", "home", "corp", "onion"].includes(labels.at(-1) ?? "")
    ) throw new Error("Crawler hostname is not public");
  } else {
    assertPublicAddress(hostname);
  }
  return url;
}

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? "ipv4" : "ipv6") ||
    (family === 6 && !publicIpv6.check(address, "ipv6"))) {
    throw new Error("Crawler target address is not public");
  }
}

export async function resolvePublicTarget(
  value: string | URL,
  resolver: DnsResolver = defaultResolver,
): Promise<{ url: URL; address: Address }> {
  const url = validatePublicUrl(value.toString());
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : await resolver(hostname);
  if (addresses.length === 0) throw new Error("Crawler target has no DNS addresses");
  // Any unsafe answer fails closed, including mixed public/private DNS responses.
  for (const answer of addresses) {
    if (answer.family !== isIP(answer.address)) throw new Error("Crawler DNS address family mismatch");
    assertPublicAddress(answer.address);
  }
  return { url, address: addresses[0]! };
}

export type SafePage = {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
};

export async function readPublicPage(
  value: string,
  resolver: DnsResolver = defaultResolver,
): Promise<SafePage> {
  let next = value;
  const signal = AbortSignal.timeout(CRAWL_LIMITS.timeoutMs);
  for (let redirects = 0; redirects <= CRAWL_LIMITS.maxRedirects; redirects++) {
    // Re-resolve and validate each hop. The socket uses the selected validated IP.
    const { url, address } = await withAbort(resolvePublicTarget(next, resolver), signal);
    const response = await requestOnce(url, address, signal);
    const location = response.headers.location;
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.destroy();
      if (redirects === CRAWL_LIMITS.maxRedirects) throw new Error("Crawler redirect limit exceeded");
      next = new URL(location, url).toString();
      continue;
    }
    const contentType = response.headers["content-type"]?.split(";")[0]?.toLowerCase() ?? "";
    if (!["text/html", "text/plain", "application/xml", "text/xml", "application/xhtml+xml"].includes(contentType)) {
      response.destroy();
      throw new Error("Crawler response content type is not allowed");
    }
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > CRAWL_LIMITS.maxResponseBytes) {
      response.destroy();
      throw new Error("Crawler response size limit exceeded");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > CRAWL_LIMITS.maxResponseBytes) {
        response.destroy();
        throw new Error("Crawler response size limit exceeded");
      }
      chunks.push(bytes);
    }
    return { url: url.toString(), status: response.statusCode ?? 0, contentType, body: Buffer.concat(chunks) };
  }
  throw new Error("Crawler redirect limit exceeded");
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function requestOnce(url: URL, address: Address, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      agent: false,
      family: address.family,
      signal,
      headers: { "accept-encoding": "identity" },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, resolve);
    request.on("error", reject);
    request.end();
  });
}
