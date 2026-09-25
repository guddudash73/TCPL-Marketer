import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request: requestMock }));
vi.mock("node:https", () => ({ request: requestMock }));

import { readPublicPage, type DnsResolver } from "../src/crawler/safe-http.js";

type Reply = { status: number; headers: Record<string, string>; chunks?: Buffer[] };
const replies: Reply[] = [];
const publicDns: DnsResolver = async () => [{ address: "93.184.215.14", family: 4 }];

beforeEach(() => {
  replies.length = 0;
  requestMock.mockReset();
  requestMock.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const reply = replies.shift();
      if (!reply) throw new Error("No mocked crawler response");
      const response = Readable.from(reply.chunks ?? []) as Readable & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = reply.status;
      response.headers = reply.headers;
      callback(response);
    };
    return request;
  });
});

describe("bounded crawler transport", () => {
  it("pins the validated DNS answer and returns bounded HTML", async () => {
    replies.push({ status: 200, headers: { "content-type": "text/html" }, chunks: [Buffer.from("<h1>OK</h1>")] });
    const page = await readPublicPage("https://example.com/", publicDns);
    expect(page.body.toString()).toBe("<h1>OK</h1>");
    expect(page.contentType).toBe("text/html");
    const options = requestMock.mock.calls[0]![1];
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    expect(options.headers["accept-encoding"]).toBe("identity");
    const selected = await new Promise((resolve) => options.lookup("example.com", {}, (_error: unknown, address: string, family: number) => resolve({ address, family })));
    expect(selected).toEqual({ address: "93.184.215.14", family: 4 });
  });

  it("revalidates a redirect and rejects a private destination before connecting", async () => {
    replies.push({ status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(readPublicPage("https://example.com/", publicDns)).rejects.toThrow("not public");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks DNS on a same-host redirect and rejects a changed private answer", async () => {
    replies.push({ status: 302, headers: { location: "/next" } });
    const resolver = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(readPublicPage("https://example.com/", resolver)).rejects.toThrow("not public");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect limit breach", async () => {
    for (let i = 0; i < 4; i++) replies.push({ status: 302, headers: { location: "/next" } });
    await expect(readPublicPage("https://example.com/", publicDns)).rejects.toThrow("redirect limit");
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized declared and streamed responses", async () => {
    replies.push({ status: 200, headers: { "content-type": "text/html", "content-length": "2000001" } });
    await expect(readPublicPage("https://example.com/", publicDns)).rejects.toThrow("size limit");
    replies.push({ status: 200, headers: { "content-type": "text/html" }, chunks: [Buffer.alloc(2_000_001)] });
    await expect(readPublicPage("https://example.com/", publicDns)).rejects.toThrow("size limit");
  });

  it("rejects unexpected content types", async () => {
    replies.push({ status: 200, headers: { "content-type": "application/octet-stream" } });
    await expect(readPublicPage("https://example.com/", publicDns)).rejects.toThrow("content type");
  });

  it("times out while waiting for DNS", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const pending = readPublicPage("https://example.com/", () => new Promise(() => {}));
      controller.abort(new Error("timeout"));
      await expect(pending).rejects.toThrow("timeout");
      expect(requestMock).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });
});
