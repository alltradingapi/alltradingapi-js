import { describe, expect, it } from "vitest";

import {
  ALLError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  UpstreamError,
  ValidationError,
  errorFromResponse,
} from "../src/errors.js";

const URL = "https://alltradingapi.com/qx_candles?asset=EURUSD_otc&key=ap_secret";

describe("errorFromResponse", () => {
  it("maps every documented status", () => {
    const body = (text: string) => Buffer.from(text, "utf-8");
    expect(errorFromResponse(400, body('{"error":"bad"}'), URL)).toBeInstanceOf(ValidationError);
    expect(errorFromResponse(401, body('{"error":"no key"}'), URL)).toBeInstanceOf(
      AuthenticationError,
    );
    expect(errorFromResponse(403, body('{"error":"no product"}'), URL)).toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(errorFromResponse(404, body('{"error":"nope"}'), URL)).toBeInstanceOf(NotFoundError);
    expect(errorFromResponse(429, body('{"error":"slow down"}'), URL, { "Retry-After": "3" })).toBeInstanceOf(
      RateLimitError,
    );
    expect(errorFromResponse(502, body('{"error":"feed"}'), URL)).toBeInstanceOf(UpstreamError);
    expect(errorFromResponse(500, body('{"error":"boom"}'), URL)).toBeInstanceOf(ServerError);
    expect(errorFromResponse(599, body(""), URL)).toBeInstanceOf(ServerError);
    expect(errorFromResponse(418, body(""), URL)).toBeInstanceOf(ALLError);
  });

  it("carries the server text, payload and redacted URL", () => {
    const err = errorFromResponse(400, Buffer.from('{"error":"That parameter is not available."}'), URL);
    expect(err.message).toContain("server: That parameter is not available.");
    expect(err.payload).toEqual({ error: "That parameter is not available." });
    expect(err.status).toBe(400);
    expect(err.url).not.toContain("ap_secret");
    expect(err.url).toContain("key=***");
  });

  it("parses Retry-After when present", () => {
    const err = errorFromResponse(429, Buffer.from("{}"), URL, { "Retry-After": "7" });
    expect((err as RateLimitError).retryAfter).toBe(7);
    const noHeader = errorFromResponse(429, Buffer.from("{}"), URL);
    expect((noHeader as RateLimitError).retryAfter).toBeNull();
  });

  it("falls back to message key and handles non-JSON bodies", () => {
    const err = errorFromResponse(401, Buffer.from('{"message":"Key required"}'), URL);
    expect(err.message).toContain("server: Key required");
    const raw = errorFromResponse(400, Buffer.from("<html>oops</html>"), URL);
    expect(raw.payload).toEqual({});
    expect(raw.message).not.toContain("server:");
  });

  it("serialises to a redacted dict", () => {
    const err = new ValidationError("bad param", { status: 400, url: URL });
    const dict = err.toDict();
    expect(dict).toMatchObject({ error: "validation_error", status: 400, url: expect.not.stringContaining("ap_secret") });
  });
});
