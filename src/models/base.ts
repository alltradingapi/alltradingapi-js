/**
 * Shared model plumbing: the `APIObject` base and the SDK's outcome enum.
 */

import { isRecordLike, type RecordLike } from "../types.js";

/** Lazily convert nested dicts/lists into APIObject-friendly structures. */
function convert(value: unknown): unknown {
  if (isRecordLike(value)) return new APIObject(value);
  if (Array.isArray(value)) return value.map((item) => convert(item));
  return value;
}

function toPlain(value: unknown): unknown {
  if (isRecordLike(value)) {
    const out: RecordLike = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (value instanceof APIObject) return toPlain(value.data);
  return value;
}

/**
 * Dict-backed base class for every API model.
 *
 * - `get(key)` maps to payload keys; hyphens/spaces in keys are normalised to
 *   underscores for lookup.
 * - Nested objects convert lazily to `APIObject`; nested arrays convert their
 *   object members on access.
 * - `toJSON()` round-trips to the original payload.
 */
export class APIObject {
  protected readonly _data: RecordLike;

  constructor(data?: unknown) {
    this._data = isRecordLike(data) ? { ...data } : {};
  }

  /** The underlying payload dict (shallow copy). */
  get raw(): RecordLike {
    return { ...this._data };
  }

  /** The live underlying payload dict. */
  get data(): RecordLike {
    return this._data;
  }

  /** Return `payload[key]` or `defaultValue`, with lazy conversion applied. */
  get(key: string, defaultValue?: unknown): unknown {
    if (key in this._data) return convert(this._data[key]);
    const normalized: Record<string, string> = {};
    for (const k of Object.keys(this._data)) {
      normalized[k.replace(/-/g, "_").replace(/ /g, "_")] = k;
    }
    if (key in normalized) {
      const mapped = normalized[key];
      if (mapped !== undefined) return convert(this._data[mapped]);
    }
    return defaultValue;
  }

  has(key: string): boolean {
    return key in this._data;
  }

  get size(): number {
    return Object.keys(this._data).length;
  }

  keys(): string[] {
    return Object.keys(this._data);
  }

  items(): Array<[string, unknown]> {
    return Object.keys(this._data).map((key) => [key, this.get(key)]);
  }

  [Symbol.iterator](): IterableIterator<string> {
    return Object.keys(this._data)[Symbol.iterator]();
  }

  /** Return a plain object copy that round-trips to the original payload. */
  toJSON(): RecordLike {
    return toPlain(this._data) as RecordLike;
  }

  /** Build a list of instances from a bare-array payload. */
  static fromRows<T extends APIObject>(this: new (row: unknown) => T, rows: unknown): T[] {
    if (!Array.isArray(rows)) return [];
    return rows.filter(isRecordLike).map((row) => new this(row));
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    const keys = Object.keys(this._data).sort().slice(0, 8);
    const more = Object.keys(this._data).length > 8 ? ", …" : "";
    return `<${this.constructor.name} ${keys.join(", ")}${more}>`;
  }
}

// ---------------------------------------------------------------------------
// Trade outcome enum
// ---------------------------------------------------------------------------

/** Outcome values returned by /qx_result. */
export const TradeOutcome = {
  WIN: "win",
  WIN_1: "win1",
  WIN_2: "win2",
  REFUND: "refund",
  LOSE: "lose",
  PENDING: "pending",
} as const;

export type TradeOutcome = (typeof TradeOutcome)[keyof typeof TradeOutcome];

export const TRADE_OUTCOME_VALUES: readonly TradeOutcome[] = [
  TradeOutcome.WIN,
  TradeOutcome.WIN_1,
  TradeOutcome.WIN_2,
  TradeOutcome.REFUND,
  TradeOutcome.LOSE,
  TradeOutcome.PENDING,
];

/** Coerce `value` to a `TradeOutcome` with tolerant matching, else null. */
export function coerceOutcome(value: unknown): TradeOutcome | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  for (const member of TRADE_OUTCOME_VALUES) {
    if (text === member) return member;
    if (text.toUpperCase().replace(/-/g, "_").replace(/ /g, "_") === member.toUpperCase()) {
      return member;
    }
  }
  return null;
}

/** True for win / win1 / win2. */
export function outcomeWon(value: TradeOutcome): boolean {
  return value === TradeOutcome.WIN || value === TradeOutcome.WIN_1 || value === TradeOutcome.WIN_2;
}

/** True for lose. */
export function outcomeLost(value: TradeOutcome): boolean {
  return value === TradeOutcome.LOSE;
}

/** True for pending. */
export function outcomePending(value: TradeOutcome): boolean {
  return value === TradeOutcome.PENDING;
}
