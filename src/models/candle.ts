/** Candle models — OHLC bars from `/qx_candles`, `/qx_history`, `/qx_saved`. */

import { isRecordLike } from "../types.js";
import { APIObject } from "./base.js";

const DOJI_BODY_RATIO = 0.1; // body < 10% of full range counts as a doji

function intOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** One OHLC bar with tick metadata and typed convenience helpers. */
export class Candle extends APIObject {
  /** Bar open time as unix seconds. */
  get time(): number {
    return intOrZero(this._data["time"]);
  }

  get open(): number {
    return Number(this._data["open"] ?? 0) || 0;
  }

  get high(): number {
    return Number(this._data["high"] ?? 0) || 0;
  }

  get low(): number {
    return Number(this._data["low"] ?? 0) || 0;
  }

  get close(): number {
    return Number(this._data["close"] ?? 0) || 0;
  }

  get ticks(): number {
    return intOrZero(this._data["ticks"]);
  }

  /** Unix timestamp (with fraction) of the last tick in the bar. */
  get lastTick(): number {
    const parsed = Number(this._data["last_tick"] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  get asset(): string {
    return String(this._data["asset"] ?? "") || "";
  }

  get assetName(): string {
    return String(this._data["asset_name"] ?? "") || "";
  }

  /** Formatted bar time as the server rendered it. */
  get timeRead(): string {
    return String(this._data["time_read"] ?? "") || "";
  }

  // -- derived helpers ---------------------------------------------------
  /** Bar open time as a JS `Date` (UTC epoch based). */
  get dt(): Date {
    return new Date(this.time * 1000);
  }

  /** `"call"` when bullish, `"put"` when bearish, else `"neutral"`. */
  get direction(): "call" | "put" | "neutral" {
    if (this.close > this.open) return "call";
    if (this.close < this.open) return "put";
    return "neutral";
  }

  get isBullish(): boolean {
    return this.close > this.open;
  }

  /** Absolute open-to-close distance. */
  get body(): number {
    return Math.abs(this.close - this.open);
  }

  /** High-to-low distance. */
  get range(): number {
    return Math.abs(this.high - this.low);
  }

  /** True when the body is smaller than `threshold` of the full range. */
  isDoji(threshold: number = DOJI_BODY_RATIO): boolean {
    const full = this.range;
    if (full <= 0) return true;
    return this.body / full < threshold;
  }

  /** Compact `(time, open, high, low, close)` row for tabular output. */
  toRow(): { time: number; open: number; high: number; low: number; close: number } {
    return {
      time: this.time,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
    };
  }
}

/** Envelope returned by `/qx_saved` (with `raw=true` the body may be a bare list). */
export class SavedCandles extends APIObject {
  get asset(): string {
    return String(this._data["asset"] ?? "") || "";
  }

  get timeframe(): string {
    return String(this._data["timeframe"] ?? "") || "";
  }

  get period(): number {
    return intOrZero(this._data["period"]);
  }

  get requestedCount(): number {
    return intOrZero(this._data["requested_count"]);
  }

  get returnedCount(): number {
    return intOrZero(this._data["returned_count"]);
  }

  get basePeriod(): number {
    return intOrZero(this._data["base_period"]);
  }

  get daysScanned(): number {
    return intOrZero(this._data["days_scanned"]);
  }

  get raw5sCandles(): number {
    return intOrZero(this._data["raw_5s_candles"]);
  }

  get fromCache(): boolean {
    return Boolean(this._data["from_cache"]);
  }

  get candles(): Candle[] {
    const rows = this._data["candles"];
    if (Array.isArray(rows)) {
      return rows.filter(isRecordLike).map((row) => new Candle(row));
    }
    return [];
  }

  get length(): number {
    return this.candles.length;
  }

  /** Accept either the object envelope or a bare candle list. */
  static fromPayload(payload: unknown): SavedCandles {
    if (Array.isArray(payload)) return new SavedCandles({ candles: payload });
    if (isRecordLike(payload)) return new SavedCandles(payload);
    return new SavedCandles({});
  }
}
