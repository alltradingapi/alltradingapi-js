/** Trade-result models from `/qx_result`. */

import { isRecordLike } from "../types.js";
import { APIObject, coerceOutcome, TradeOutcome, outcomeWon } from "./base.js";
import { Candle } from "./candle.js";

function intOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** Outcome of a checked trade entry from `/qx_result`. */
export class TradeResult extends APIObject {
  get success(): boolean {
    return Boolean(this._data["success"]);
  }

  get asset(): string {
    return String(this._data["asset"] ?? "") || "";
  }

  get timeframe(): string {
    return String(this._data["timeframe"] ?? "") || "";
  }

  get direction(): string {
    return String(this._data["direction"] ?? "") || "";
  }

  get mtg(): number {
    return intOrZero(this._data["mtg"]);
  }

  get entryTime(): string {
    return String(this._data["entry_time"] ?? "") || "";
  }

  /** Coerced per-candle outcome values (candles that carry a status). */
  get outcomes(): TradeOutcome[] {
    const values: TradeOutcome[] = [];
    const candles = this._data["candles"] ?? [];
    if (Array.isArray(candles)) {
      for (const entry of candles) {
        if (isRecordLike(entry) && "status" in entry) {
          const coerced = coerceOutcome(entry["status"]);
          if (coerced !== null) values.push(coerced);
        }
      }
    }
    const resultValue = this.result;
    if (resultValue !== null && (values.length === 0 || this.mtg > 1)) {
      values.push(resultValue);
    }
    return values;
  }

  /** Raw per-check status strings from the payload. */
  get checks(): string[] {
    const value = this._data["checks"];
    if (Array.isArray(value)) return value.map((v) => String(v));
    return [];
  }

  get candleDirections(): string[] {
    const value = this._data["candle_directions"];
    if (Array.isArray(value)) return value.map((v) => String(v));
    return [];
  }

  /** Final result coerced to a `TradeOutcome`. */
  get result(): TradeOutcome | null {
    return coerceOutcome(this._data["result"]);
  }

  /** Candles attached to the result (pending markers are skipped). */
  get candles(): Candle[] {
    const entries = this._data["candles"] ?? [];
    if (!Array.isArray(entries)) return [];
    const out: Candle[] = [];
    for (const entry of entries) {
      if (isRecordLike(entry) && "time" in entry) out.push(new Candle(entry));
    }
    return out;
  }

  /** Convenience: true when any reported outcome is a win. */
  get won(): boolean {
    return this.outcomes.some((o) => outcomeWon(o));
  }
}
