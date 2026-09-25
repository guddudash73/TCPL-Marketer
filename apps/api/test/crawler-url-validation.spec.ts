import { describe, expect, it, vi } from "vitest";

import {
  assertPublicAddress,
  readPublicPage,
  resolvePublicTarget,
  validatePublicUrl,
  type DnsResolver,
} from "../src/crawler/safe-http.js";

const publicDns: DnsResolver = async () => [{ address: "93.184.215.14", family: 4 }];

describe("crawler URL and SSRF boundary", () => {
  it.each([
    "file:///etc/passwd", "ftp://example.com/file", "http://localhost/",
    "http://localhost./", "http://intranet/", "http://service.internal/",
    "http://router.local/", "http://user:password@example.com/",
    "http://example.com:8080/",
    "http://127.1/", "http://0177.0.0.1/", "http://0x7f000001/",
    "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
    "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[2001:db8::1]/",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validatePublicUrl(url)).toThrow();
  });

  it.each(["http://example.com/path", "https://sub.example.org/", "http://93.184.215.14/", "https://[2001:4860:4860::8888]/"])(
    "accepts a public HTTP(S) URL %s",
    (url) => expect(validatePublicUrl(url).toString()).toBe(url),
  );

  it.each(["0.0.0.0", "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.0.1", "198.18.0.1", "224.0.0.1", "::", "::1", "2002::1"])(
    "rejects nonpublic address %s", (address) => expect(() => assertPublicAddress(address)).toThrow(),
  );

  it("rejects a DNS response containing a private address, even when another answer is public", async () => {
    const resolver: DnsResolver = async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(resolvePublicTarget("https://example.com/", resolver)).rejects.toThrow("not public");
  });

  it("rejects empty and malformed DNS answers", async () => {
    await expect(resolvePublicTarget("https://example.com/", async () => [])).rejects.toThrow("no DNS");
    await expect(resolvePublicTarget("https://example.com/", async () => [{ address: "::1", family: 4 }])).rejects.toThrow("mismatch");
  });

  it("resolves an approved domain to a validated address", async () => {
    const resolver = vi.fn(publicDns);
    const target = await resolvePublicTarget("https://example.com/a", resolver);
    expect(target.address).toEqual({ address: "93.184.215.14", family: 4 });
    expect(resolver).toHaveBeenCalledWith("example.com");
  });

  it("rejects a blocked target before issuing an HTTP request", async () => {
    const resolver = vi.fn(publicDns);
    await expect(readPublicPage("http://169.254.169.254/", resolver)).rejects.toThrow("not public");
    expect(resolver).not.toHaveBeenCalled();
  });
});
