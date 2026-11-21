import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TransportError,
  UpstreamError,
  ValidationError,
} from "../src/errors.js";
import { Transport } from "../src/transport.js";
import { startFakeServer, type FakeServer } from "./fakeServer.js";

let server: FakeServer;

beforeAll(async () => {
  server = await startFakeServer();
});

afterAll(async () => {
  await server.close();
});

const tx = (opts: Partial<ConstructorParameters<typeof Transport>[0]> = {}) =>
  new Transport({ baseUrl: server.baseUrl, ...opts });

describe("transport", () => {
  it("performs a JSON GET with query params", async () => {
    const transport = tx({ maxRetries: 0 });
    const res = await transport.request("GET", "/qx_candles", {
      params: [["asset", "EURUSD_otc"], ["hours", "2"]],
      headers: { Authorization: "Bearer ap_test" },
    });
    expect(res.status).toBe(200);
    const payload = res.json() as unknown[];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(6);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(res.header("Content-Type")).toContain("application/json");
    expect(res.text).toContain("ATOUSD_otc");
  });

  it("transparently decompresses gzip responses", async () => {
    const transport = tx({ maxRetries: 0 });
    const res = await transport.request("GET", "/qx_gzip");
    expect(res.status).toBe(200);
    const payload = res.json() as unknown[];
    expect(payload).toHaveLength(6);
    // content-length reflects the *decompressed* body, like the Python SDK
    expect(Number(res.header("content-length"))).toBe(res.content.length);
  });

  it("maps error statuses to SDK errors", async () => {
    const transport = tx({ maxRetries: 0 });
    await expect(transport.request("GET", "/qx_400")).rejects.toBeInstanceOf(ValidationError);
    await expect(transport.request("GET", "/qx_401")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(transport.request("GET", "/qx_403")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(transport.request("GET", "/qx_502")).rejects.toBeInstanceOf(UpstreamError);
    await expect(transport.request("GET", "/qx_500")).rejects.toBeInstanceOf(ServerError);
    await expect(transport.request("GET", "/qx_missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("retries 429 for GET and honours Retry-After", async () => {
    const transport = tx({ maxRetries: 1, backoffFactor: 0 });
    const before = server.hits["/qx_429_fast"] ?? 0;
    await expect(transport.request("GET", "/qx_429_fast")).rejects.toBeInstanceOf(RateLimitError);
    expect((server.hits["/qx_429_fast"] ?? 0) - before).toBe(2); // 1 attempt + 1 retry
  });

  it("never retries 429 for POST", async () => {
    const transport = tx({ maxRetries: 2, backoffFactor: 0 });
    const before = server.hits["/qx_429"] ?? 0;
    await expect(transport.request("POST", "/qx_429")).rejects.toBeInstanceOf(RateLimitError);
    expect((server.hits["/qx_429"] ?? 0) - before).toBe(1);
  });

  it("retries POST at most once and only on 5xx", async () => {
    const transport = tx({ maxRetries: 3, backoffFactor: 0 });
    const before = server.hits["/qx_500"] ?? 0;
    await expect(transport.request("POST", "/qx_500")).rejects.toBeInstanceOf(ServerError);
    expect((server.hits["/qx_500"] ?? 0) - before).toBe(2);
  });

  it("retains the Retry-After value on the error", async () => {
    const transport = tx({ maxRetries: 0 });
    const err = await transport.request("GET", "/qx_429").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(1);
  });

  it("serves the PNG screenshot bytes untouched", async () => {
    const transport = tx({ maxRetries: 0 });
    const res = await transport.request("GET", "/qx_ss_pro_v2");
    expect(res.contentType).toBe("image/png");
    expect(res.content.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(res.content.length).toBe(72);
  });

  it("throws a parse error on truncated JSON", async () => {
    const transport = tx({ maxRetries: 0 });
    const res = await transport.request("GET", "/qx_truncated");
    expect(() => res.json()).toThrow();
  });

  it("redacts keys from error URLs", async () => {
    const transport = tx({ maxRetries: 0 });
    try {
      await transport.request("GET", "/qx_401", {
        params: [["key", "ap_secret123"]],
      });
      expect.unreachable("expected an error");
    } catch (err) {
      expect((err as TransportError).url).not.toContain("ap_secret123");
      expect((err as TransportError).url).toContain("key=***");
    }
  });

  it("rotates browser-like User-Agents", async () => {
    const transport = tx({ maxRetries: 0 });
    await transport.request("GET", "/qx_candles");
    expect(server.lastUserAgent).toBeTruthy();
    expect(server.lastUserAgent).toMatch(/Mozilla\/5\.0/);
  });

  it("rejects a bad base URL", () => {
    expect(() => new Transport({ baseUrl: "ftp://example.com" })).toThrow(/base_url must start with/);
  });
});
