/**
 * Package-wide constants and environment helpers.
 *
 * Everything user-tunable lives here so tests and docs can point at one place.
 */

import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Service coordinates
// ---------------------------------------------------------------------------
export const BASE_URL = "https://alltradingapi.com";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/alltradingapi/latest";
export const NPM_PACKAGE = "alltradingapi";

// ---------------------------------------------------------------------------
// Request behaviour
// ---------------------------------------------------------------------------
export const DEFAULT_TIMEOUT = 30.0; // read timeout, seconds
export const DEFAULT_CONNECT_TIMEOUT = 10.0; // connect timeout, seconds
export const DEFAULT_MAX_RETRIES = 2; // extra attempts after the first
export const DEFAULT_BACKOFF_FACTOR = 0.5; // seconds, exponential with full jitter
export const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];
export const DEFAULT_USER_AGENT = "alltradingapi-js/1.0.0";
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MiB safety cap per response
export const DEFAULT_AUTH_MODE = "bearer" as const; // "bearer" (preferred) or "query"
export const DEFAULT_CACHE_TTL = 60.0; // seconds; assets() only
export const CONNECTION_POOL_SIZE = 8; // idle keep-alive connections per host

// ---------------------------------------------------------------------------
// Update gate
// ---------------------------------------------------------------------------
export const UPDATE_CHECK_TIMEOUT = 2.0; // hard cap so the gate can never hang
export const UPDATE_CACHE_TTL = 6 * 3600; // 6 hours between live registry checks
export const UPDATE_CACHE_FILE = "alltradingapi/update.json";

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
export const ENV_API_KEY = "ATA_API_KEY";
export const ENV_KEY_PREFIX = "ATA_KEY_"; // + PRODUCT.upper().replace("-", "_")
export const ENV_UPDATE_POLICY = "ATA_UPDATE_POLICY";
export const ENV_UPDATE_TTL = "ATA_UPDATE_TTL";
export const ENV_SKIP_UPDATE = "ATA_SKIP_UPDATE";
export const ENV_NO_PROMPT = "ATA_NO_PROMPT";
export const ENV_CI = "ATA_CI";
export const ENV_HTTP_PROXY = "ATA_HTTP_PROXY";
export const ENV_HTTPS_PROXY = "ATA_HTTPS_PROXY";

export const CI_ENV_VARS = ["CI", "GITHUB_ACTIONS"] as const;

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export const PRODUCTS = [
  "quotex-assets",
  "quotex-quotes",
  "quotex-realtime",
  "quotex-saved",
  "quotex-screenshots",
  "quotex-results",
] as const;

export type Product = (typeof PRODUCTS)[number];

// Asset symbols are validated before any request is made.
export const ASSET_PATTERN = "^[A-Za-z0-9_]{2,40}$";

export const TIMEFRAME_LABELS = [
  "5s",
  "10s",
  "15s",
  "30s",
  "1m",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
] as const;

export type Timeframe = (typeof TIMEFRAME_LABELS)[number];

export const TIMEFRAME_SECONDS: Record<string, number> = {
  "5s": 5,
  "10s": 10,
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "2m": 120,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
};

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
export function env(name: string, fallback = ""): string {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

export function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isCI(): boolean {
  if (envBool(ENV_CI)) return true;
  for (const name of CI_ENV_VARS) {
    const value = process.env[name] ?? "";
    if (value && value.toLowerCase() !== "0" && value.toLowerCase() !== "false") {
      return true;
    }
  }
  return false;
}

export function isInteractive(): boolean {
  if (isCI()) return false;
  if (envBool(ENV_NO_PROMPT)) return false;
  try {
    return Boolean(process.stdin.isTTY);
  } catch {
    return false;
  }
}

/** Best-effort per-user cache directory (Windows %LOCALAPPDATA% first). */
export function cacheDir(): string {
  const candidates = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.XDG_CACHE_HOME,
    path.join(os.homedir(), ".cache"),
  ];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return os.tmpdir(); // HOME-less systems
}
