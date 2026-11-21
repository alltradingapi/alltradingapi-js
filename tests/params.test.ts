import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors.js";
import { allowedParams, validateParams } from "../src/params.js";

describe("params", () => {
  it("exposes exactly the documented sets", () => {
    expect(allowedParams("assets")).toEqual(["account"]);
    expect(allowedParams("candles")).toEqual(
      expect.arrayContaining([
        "asset",
        "account",
        "hours",
        "timeframe",
        "timezone",
        "offset",
        "timestamp",
        "timeout",
        "verbose_logging",
        "period",
      ]),
    );
    expect(allowedParams("history")).toEqual(allowedParams("candles"));
    expect(allowedParams("result")).toEqual(
      expect.arrayContaining(["asset", "time", "timeframe", "timezone", "direction", "mtg"]),
    );
    expect(allowedParams("nope")).toEqual([]);
  });

  it("rejects unknown parameters before any request", () => {
    expect(() => validateParams("candles", { asset: "EURUSD_otc", nope: "x" })).toThrow(
      ValidationError,
    );
    expect(() => validateParams("candles", { asset: "EURUSD_otc", nope: "x" })).toThrow(
      /Unknown parameter/,
    );
    // Explicit nulls are treated as "not provided", not unknown.
    expect(validateParams("candles", { asset: "EURUSD_otc", hours: null })).toEqual([
      ["asset", "EURUSD_otc"],
    ]);
  });

  it("enforces required parameters", () => {
    expect(() => validateParams("candles", {})).toThrow(/Missing required parameter 'asset'/);
    expect(() => validateParams("result", { asset: "EURUSD_otc" })).toThrow(
      /Missing required parameter 'time'/,
    );
  });

  it("enforces ranges", () => {
    expect(() => validateParams("candles", { asset: "EURUSD_otc", hours: 0 })).toThrow(
      /must be >= 1/,
    );
    expect(() => validateParams("candles", { asset: "EURUSD_otc", hours: 25 })).toThrow(
      /must be <= 24/,
    );
    expect(() => validateParams("assets", { account: -1 })).toThrow(/must be >= 0/);
    expect(() => validateParams("assets", { account: 100 })).toThrow(/must be <= 99/);
    expect(validateParams("candles", { asset: "EURUSD_otc", hours: 24 })).toEqual([
      ["asset", "EURUSD_otc"],
      ["hours", "24"],
    ]);
  });

  it("enforces enums", () => {
    expect(() => validateParams("candles", { asset: "EURUSD_otc", timeframe: "7m" })).toThrow(
      /Invalid timeframe '7m'/,
    );
    expect(() => validateParams("result", { asset: "EURUSD_otc", time: "20:00", direction: "side" })).toThrow(
      /Invalid direction 'side'. Valid values: call, put/,
    );
    expect(validateParams("candles", { asset: "EURUSD_otc", timeframe: "5m" })).toEqual([
      ["asset", "EURUSD_otc"],
      ["timeframe", "5m"],
    ]);
  });

  it("enforces types", () => {
    expect(() => validateParams("candles", { asset: "EURUSD_otc", hours: "2" })).toThrow(
      /expects an integer/,
    );
    expect(() => validateParams("candles", { asset: "EURUSD_otc", hours: 1.5 })).toThrow(
      /expects an integer/,
    );
    expect(() => validateParams("candles", { asset: 42 })).toThrow(/expects a string/);
    expect(() => validateParams("candles", { asset: "EURUSD_otc", verbose_logging: "yes" })).toThrow(
      /expects a boolean/,
    );
  });

  it("serialises booleans as true and omits false", () => {
    expect(validateParams("saved", { asset: "EURUSD_otc", raw: true })).toEqual([
      ["asset", "EURUSD_otc"],
      ["raw", "true"],
    ]);
    // false is the server default; `param=false` is rejected with a 400.
    expect(validateParams("saved", { asset: "EURUSD_otc", raw: false })).toEqual([
      ["asset", "EURUSD_otc"],
    ]);
    expect(validateParams("candles", { asset: "EURUSD_otc", verbose_logging: true })).toEqual([
      ["asset", "EURUSD_otc"],
      ["verbose_logging", "true"],
    ]);
  });

  it("validates and trims asset symbols for the query only", () => {
    const params = validateParams("candles", { asset: " EURUSD_otc " });
    expect(params[0]).toEqual(["asset", "EURUSD_otc"]);
    expect(() => validateParams("candles", { asset: "EUR USD" })).toThrow(/Invalid asset/);
  });

  it("validates HH:MM times", () => {
    expect(() => validateParams("result", { asset: "EURUSD_otc", time: "8pm", direction: "call" })).toThrow(
      /Invalid time '8pm'/,
    );
    expect(validateParams("result", { asset: "EURUSD_otc", time: "20:00:30", direction: "put" })).toContainEqual([
      "time",
      "20:00:30",
    ]);
  });

  it("rejects unknown endpoints", () => {
    expect(() => validateParams("nope", {})).toThrow(/Unknown endpoint 'nope'/);
  });
});
