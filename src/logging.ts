/**
 * Logging setup for the SDK.
 *
 * The SDK logs to stderr at these levels:
 *
 * - DEBUG — request/response lines with **redacted** keys and timings
 * - WARNING — retries
 * - INFO — update-gate events
 * - ERROR — failures
 *
 * Payloads are never logged at INFO. Keys are redacted everywhere.
 */

import { REDACTED, redactUrl } from "./utils.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

let currentLevel: number = LEVELS.warn;

function format(args: unknown[]): string {
  if (args.length === 0) return "";
  return " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
}

function stamp(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, threshold: number, message: string, rest: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(`${stamp()} alltradingapi ${level.toUpperCase()} ${message}${format(rest)}\n`);
}

/** Default SDK logger. Attach your own via `Client({ logger })`. */
export const logger: Logger = {
  debug: (message, ...rest) => emit("debug", currentLevel, message, rest),
  info: (message, ...rest) => emit("info", currentLevel, message, rest),
  warn: (message, ...rest) => emit("warn", currentLevel, message, rest),
  error: (message, ...rest) => emit("error", currentLevel, message, rest),
};

/**
 * Configure the SDK logger level (`"DEBUG"`, `"INFO"`, `"WARN"`, `"ERROR"`).
 * Unknown levels fall back to WARN, mirroring the Python SDK.
 */
export function setLogLevel(level: string): void {
  const key = String(level).toLowerCase() as LogLevel;
  currentLevel = LEVELS[key] ?? LEVELS.warn;
}

/** Build a single redacted DEBUG line for a request/response. */
export function httpDebugLine(
  method: string,
  url: string,
  opts: { status?: number; elapsedMs?: number; attempt?: number } = {},
): string {
  const safeUrl = redactUrl(url) ?? "<url>";
  const parts = [method, safeUrl];
  if (opts.status !== undefined) parts.push(`-> ${opts.status}`);
  if (opts.elapsedMs !== undefined) parts.push(`${Math.round(opts.elapsedMs)}ms`);
  if (opts.attempt) parts.push(`attempt=${opts.attempt + 1}`);
  return parts.join(" ");
}

/** Return a non-sensitive fingerprint of an API key for cache/debug keys. */
export function redactedKey(key: string | null | undefined): string {
  if (!key) return "none";
  return REDACTED;
}
