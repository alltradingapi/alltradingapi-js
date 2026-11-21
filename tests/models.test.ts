import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APIObject, coerceOutcome, outcomeWon, TradeOutcome } from "../src/models/base.js";
import { Asset } from "../src/models/asset.js";
import { Candle, SavedCandles } from "../src/models/candle.js";
import { TradeResult } from "../src/models/tradeResult.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(HERE, "fixtures", name), "utf-8"));

describe("APIObject", () => {
  it("normalises hyphens and spaces in keys", () => {
    const obj = new APIObject({ "some-key": 1, "other key": 2, plain: 3 });
    expect(obj.get("some_key")).toBe(1);
    expect(obj.get("other_key")).toBe(2);
    expect(obj.get("plain")).toBe(3);
    expect(obj.get("missing")).toBeUndefined();
    expect(obj.get("missing", 42)).toBe(42);
    expect(obj.has("plain")).toBe(true);
    expect(obj.size).toBe(3);
  });

  it("converts nested payloads lazily and round-trips", () => {
    const obj = new APIObject({ nested: { "deep-key": [1, { inner: "x" }] } });
    const nested = obj.get("nested") as APIObject;
    expect(nested).toBeInstanceOf(APIObject);
    const list = nested.get("deep_key") as unknown[];
    expect(list[1]).toBeInstanceOf(APIObject);
    expect(obj.toJSON()).toEqual({ nested: { "deep-key": [1, { inner: "x" }] } });
  });

  it("handles non-object payloads defensively", () => {
    const obj = new APIObject("nope");
    expect(obj.size).toBe(0);
    expect(obj.keys()).toEqual([]);
  });
});

describe("Candle", () => {
  const rows = fixture("candles.json") as Record<string, unknown>[];

  it("parses OHLC rows", () => {
    const candles = Candle.fromRows(rows);
    expect(candles).toHaveLength(6);
    const first = candles[0]!;
    expect(first.time).toBe(1763500000);
    expect(first.open).toBeCloseTo(0.19012);
    expect(first.high).toBeCloseTo(0.19032);
    expect(first.low).toBeCloseTo(0.19007);
    expect(first.close).toBeCloseTo(0.19024);
    expect(first.ticks).toBe(12);
    expect(first.lastTick).toBeCloseTo(1763500059.4);
    expect(first.asset).toBe("ATOUSD_otc");
    expect(first.timeRead).toContain("2026-11-19 01:00");
    expect(first.dt).toBeInstanceOf(Date);
    expect(first.dt.getTime()).toBe(1763500000 * 1000);
  });

  it("derives direction, body, range and doji helpers", () => {
    const bullish = Candle.fromRows(rows)[0]!; // close > open
    expect(bullish.direction).toBe("call");
    expect(bullish.isBullish).toBe(true);
    const bearish = Candle.fromRows(rows)[1]!; // close < open
    expect(bearish.direction).toBe("put");
    expect(bearish.isBullish).toBe(false);
    expect(bullish.body).toBeCloseTo(0.19024 - 0.19012);
    expect(bullish.range).toBeCloseTo(0.19032 - 0.19007);
    // body is 10%+ of range -> not a doji
    expect(bullish.isDoji()).toBe(false);
    const flat = new Candle({ open: 5, close: 5, high: 5, low: 5 });
    expect(flat.isDoji()).toBe(true);
    expect(flat.direction).toBe("neutral");
    expect(flat.body).toBe(0);
    expect(flat.range).toBe(0);
  });

  it("produces compact rows", () => {
    const candle = Candle.fromRows(rows)[0]!;
    expect(candle.toRow()).toEqual({
      time: 1763500000,
      open: 0.19012,
      high: 0.19032,
      low: 0.19007,
      close: 0.19024,
    });
  });

  it("ignores non-dict rows", () => {
    expect(Candle.fromRows([null, "x", rows[0]])).toHaveLength(1);
  });
});

describe("Asset", () => {
  const rows = fixture("assets.json") as Record<string, unknown>[];

  it("parses asset fields", () => {
    const assets = Asset.fromRows(rows);
    expect(assets).toHaveLength(3);
    const first = assets[0]!;
    expect(first.id).toBe(368);
    expect(first.symbol).toBe("ATOUSD_otc");
    expect(first.name).toBe("Cosmos (OTC)");
    expect(first.isOpen).toBe(true);
    expect(first.type).toBe("cryptocurrency");
    expect(first.payout).toBe(77);
    expect(first.change24h).toBeCloseTo(-11.56);
    expect(first.profit1m).toBe(77);
    expect(first.profit5m).toBe(69);
    expect(first.isOtc).toBe(true);
    expect(String(first)).toBe("ATOUSD_otc");
  });

  it("handles missing fields and otc detection", () => {
    const audcad = Asset.fromRows(rows)[2]!;
    expect(audcad.isOpen).toBe(false);
    expect(audcad.isOtc).toBe(false);
    const empty = new Asset({});
    expect(empty.id).toBe(0);
    expect(empty.change24h).toBeNull();
    expect(empty.profit1m).toBeNull();
  });

  it("filters with fromRows on non-dict entries", () => {
    expect(Asset.fromRows([1, null, rows[1]])).toHaveLength(1);
  });
});

describe("SavedCandles", () => {
  it("parses the object envelope", () => {
    const saved = SavedCandles.fromPayload(fixture("saved.json"));
    expect(saved.asset).toBe("ATOUSD_otc");
    expect(saved.timeframe).toBe("1m");
    expect(saved.period).toBe(60);
    expect(saved.requestedCount).toBe(3);
    expect(saved.returnedCount).toBe(3);
    expect(saved.basePeriod).toBe(5);
    expect(saved.daysScanned).toBe(1);
    expect(saved.raw5sCandles).toBe(0);
    expect(saved.fromCache).toBe(false);
    expect(saved.candles).toHaveLength(3);
    expect(saved.length).toBe(3);
    expect(saved.candles[0]).toBeInstanceOf(Candle);
  });

  it("accepts the bare list returned with raw=true", () => {
    const saved = SavedCandles.fromPayload(fixture("saved_raw.json"));
    expect(saved.candles).toHaveLength(2);
    expect(saved.asset).toBe("");
    expect(SavedCandles.fromPayload(null).candles).toEqual([]);
  });
});

describe("TradeResult", () => {
  it("parses a decided result", () => {
    const result = new TradeResult(fixture("result.json"));
    expect(result.success).toBe(true);
    expect(result.asset).toBe("ATOUSD_otc");
    expect(result.direction).toBe("call");
    expect(result.mtg).toBe(1);
    expect(result.entryTime).toBe("2026-11-19 01:04:00");
    expect(result.result).toBe(TradeOutcome.WIN);
    expect(result.outcomes).toEqual([TradeOutcome.WIN]);
    expect(result.checks).toEqual(["win"]);
    expect(result.candleDirections).toEqual(["call"]);
    expect(result.candles).toHaveLength(1);
    expect(result.won).toBe(true);
  });

  it("parses pending markers", () => {
    const result = new TradeResult(fixture("result_pending.json"));
    expect(result.result).toBe(TradeOutcome.PENDING);
    // two per-candle pending statuses + the final result appended (mtg > 1)
    expect(result.outcomes).toEqual([TradeOutcome.PENDING, TradeOutcome.PENDING, TradeOutcome.PENDING]);
    expect(result.candles).toEqual([]);
    expect(result.won).toBe(false);
  });

  it("coerces outcome values tolerantly", () => {
    expect(coerceOutcome("WIN")).toBe(TradeOutcome.WIN);
    expect(coerceOutcome("win2")).toBe(TradeOutcome.WIN_2);
    expect(coerceOutcome("REFUND")).toBe(TradeOutcome.REFUND);
    expect(coerceOutcome("lose")).toBe(TradeOutcome.LOSE);
    expect(coerceOutcome("banana")).toBeNull();
    expect(outcomeWon(TradeOutcome.WIN_1)).toBe(true);
    expect(outcomeWon(TradeOutcome.LOSE)).toBe(false);
  });
});
