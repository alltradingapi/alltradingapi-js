/**
 * Declarative endpoint parameter validation.
 *
 * The live server rejects ANY undocumented query parameter with HTTP 400
 * ("That parameter is not available on this API."). To save a round trip and
 * give better errors, this module declares, per endpoint, exactly which params
 * are allowed, their types, ranges, enums and defaults — and validates/serialises
 * them *before* the request is made.
 *
 * Rules enforced here:
 *
 * - unknown param          -> ValidationError listing allowed names
 * - out-of-range value     -> ValidationError with the accepted range
 * - invalid enum           -> ValidationError listing valid values
 * - booleans serialise as  -> "true" when true; omitted when false
 *                            (the server rejects `param=false` with a 400)
 * - `null`/`undefined`     -> omitted entirely from the query string
 * - asset format           -> validated against ^[A-Za-z0-9_]{2,40}$ (input is
 *                            trimmed for validation but never mutated)
 */

import { TIMEFRAME_LABELS } from "./config.js";
import { ValidationError } from "./errors.js";
import type { ParamValue, QueryParam } from "./types.js";
import { coerceBoolStr, isValidAsset, isValidTime } from "./utils.js";

export type { QueryParam };

// ---------------------------------------------------------------------------
// Spec language
// ---------------------------------------------------------------------------
type ParamKind = "str" | "int" | "float" | "bool";

type Transform = (value: string) => string;

interface Rule {
  kind: ParamKind;
  required: boolean;
  choices: readonly string[] | null;
  minValue: number | null;
  maxValue: number | null;
  transform: Transform | null;
  doc: string;
}

function rule(opts: Partial<Rule> & { kind: ParamKind }): Rule {
  return {
    kind: opts.kind,
    required: opts.required ?? false,
    choices: opts.choices ?? null,
    minValue: opts.minValue ?? null,
    maxValue: opts.maxValue ?? null,
    transform: opts.transform ?? null,
    doc: opts.doc ?? "",
  };
}

const str = (opts: Partial<Rule> = {}): Rule => rule({ kind: "str", ...opts });
const int = (opts: Partial<Rule> = {}): Rule => rule({ kind: "int", ...opts });
const bool = (opts: Partial<Rule> = {}): Rule => rule({ kind: "bool", ...opts });

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------
function tfTimeframe(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (!(TIMEFRAME_LABELS as readonly string[]).includes(lowered)) {
    throw new ValidationError(
      `Invalid timeframe '${value}'. Valid timeframes: ${TIMEFRAME_LABELS.join(", ")}.`,
    );
  }
  return lowered;
}

function timeStr(value: string): string {
  if (!isValidTime(value)) {
    throw new ValidationError(`Invalid time '${value}'. Expected 'HH:MM' or 'HH:MM:SS'.`);
  }
  return value.trim();
}

function asset(value: string): string {
  const trimmed = value.trim();
  if (!isValidAsset(trimmed)) {
    throw new ValidationError(
      `Invalid asset '${value}'. Asset symbols look like 'EURUSD_otc' or 'AUDCAD' ` +
        "and must match ^[A-Za-z0-9_]{2,40}$.",
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Per-endpoint parameter tables (exactly the documented sets — nothing more)
// ---------------------------------------------------------------------------
const CANDLE_PARAMS: Record<string, Rule> = {
  asset: str({ required: true, transform: asset, doc: "Asset symbol, e.g. EURUSD_otc." }),
  account: int({ minValue: 0, maxValue: 99 }),
  hours: int({ minValue: 1, maxValue: 24, doc: "Hours of history, 1..24 (default 2)." }),
  timeframe: str({ choices: TIMEFRAME_LABELS }),
  timezone: str({ doc: "e.g. '-3', 'UTC', 'Asia/Dhaka'." }),
  offset: int({ minValue: 0, maxValue: 604800 }),
  timestamp: int({ minValue: 1, maxValue: 4102444800 }),
  timeout: int({ minValue: 1, maxValue: 30 }),
  verbose_logging: bool(),
  period: int({ minValue: 1, maxValue: 86400 }),
};

export const ENDPOINT_PARAMS: Record<string, Record<string, Rule>> = {
  assets: {
    account: int({ minValue: 0, maxValue: 99, doc: "Account selector (server-defined values)." }),
  },
  candles: CANDLE_PARAMS,
  history: CANDLE_PARAMS, // same parameter set as candles
  saved: {
    asset: str({ required: true, transform: asset }),
    timeframe: str({ choices: TIMEFRAME_LABELS }),
    timezone: str(),
    count: int({ minValue: 1, maxValue: 1000 }),
    raw: bool(),
    nocache: bool(),
  },
  screenshot: {
    asset: str({ required: true, transform: asset }),
    timeframe: str({ choices: TIMEFRAME_LABELS }),
    timezone: str(),
    time: str({ transform: timeStr }),
    result: str({ doc: "Trade-result filter shown on the chart." }),
    names: str({ doc: "Pattern names overlay." }),
  },
  result: {
    asset: str({ required: true, transform: asset }),
    time: str({ required: true, transform: timeStr }),
    timeframe: str({ choices: TIMEFRAME_LABELS }),
    timezone: str(),
    direction: str({ required: true, choices: ["call", "put"] }),
    mtg: int({ minValue: 0, maxValue: 2 }),
  },
};

/** Return the documented parameter names for `endpoint`. */
export function allowedParams(endpoint: string): string[] {
  return Object.keys(ENDPOINT_PARAMS[endpoint] ?? {});
}

/**
 * Validate and serialise `params` for `endpoint`.
 *
 * Returns an ordered `[[name, value], ...]` list ready for urlencoding.
 * Raises {@link ValidationError} before any network I/O when a parameter is
 * unknown, out of range, an invalid enum, or of the wrong type.
 */
export function validateParams(
  endpoint: string,
  params: Record<string, ParamValue> = {},
): QueryParam[] {
  const table = ENDPOINT_PARAMS[endpoint];
  if (!table) throw new ValidationError(`Unknown endpoint '${endpoint}'.`);

  const unknown = Object.keys(params).filter(
    (k) => !(k in table) && params[k] !== null && params[k] !== undefined,
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown parameter(s) ${unknown.sort().map((u) => `'${u}'`).join(", ")} for '${endpoint}'. ` +
        "This API validates the exact set of documented parameters; allowed names: " +
        `${Object.keys(table).join(", ") || "(none)"}.`,
    );
  }

  const out: QueryParam[] = [];
  for (const [name, ruleEntry] of Object.entries(table)) {
    const value = params[name];
    if (value === null || value === undefined) {
      if (ruleEntry.required) {
        throw new ValidationError(`Missing required parameter '${name}' for '${endpoint}'.`);
      }
      continue;
    }
    if (ruleEntry.kind === "bool" && value === false) {
      // The server rejects `param=false` with a 400 ("not available on
      // this API"); false is the server default, so simply omit it.
      continue;
    }
    out.push([name, serialize(name, ruleEntry, value)]);
  }
  return out;
}

function serialize(name: string, ruleEntry: Rule, value: ParamValue): string {
  if (ruleEntry.kind === "bool") {
    if (typeof value !== "boolean") {
      throw new ValidationError(
        `Parameter '${name}' expects a boolean (true/false); got ${JSON.stringify(value)}.`,
      );
    }
    return coerceBoolStr(value);
  }

  if (ruleEntry.kind === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ValidationError(
        `Parameter '${name}' expects an integer; got ${JSON.stringify(value)}.`,
      );
    }
    checkRange(name, ruleEntry, value);
    return String(value);
  }

  if (ruleEntry.kind === "float") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new ValidationError(
        `Parameter '${name}' expects a number; got ${JSON.stringify(value)}.`,
      );
    }
    checkRange(name, ruleEntry, value);
    return String(value);
  }

  // str
  if (typeof value !== "string") {
    throw new ValidationError(`Parameter '${name}' expects a string; got ${JSON.stringify(value)}.`);
  }
  let text = value;
  if (ruleEntry.transform) text = ruleEntry.transform(text);
  if (ruleEntry.choices && !ruleEntry.choices.includes(text)) {
    throw new ValidationError(
      `Invalid ${name} '${text}'. Valid values: ${ruleEntry.choices.join(", ")}.`,
    );
  }
  return text;
}

function checkRange(name: string, ruleEntry: Rule, num: number): void {
  const { minValue, maxValue } = ruleEntry;
  if (minValue !== null && num < minValue) {
    throw new ValidationError(`Parameter '${name}' must be >= ${minValue}; got ${num}.`);
  }
  if (maxValue !== null && num > maxValue) {
    throw new ValidationError(`Parameter '${name}' must be <= ${maxValue}; got ${num}.`);
  }
}
