/**
 * The must-update system — detect newer npm releases and gate the SDK.
 *
 * Owner requirement: *when a newer version exists on npm, the SDK must detect
 * it, ask the user, and refuse to operate until updated — unless the user
 * explicitly opts out.*
 *
 * Design:
 *
 * - Source of truth: `https://registry.npmjs.org/alltradingapi/latest`.
 * - One network check per process, guarded by a module-level promise.
 * - Hard 2.0 s timeout; **fail-open**: offline / registry errors / 404
 *   (package not yet published) all mean "unknown, continue".
 * - Disk-cached result (default TTL 6 h, override `ATA_UPDATE_TTL` seconds).
 * - Policies: `strict` (default; gate), `ask` (prompt, continue on decline),
 *   `warn` (warn once, continue), `off` (no network at all).
 * - Escape hatches: `ATA_UPDATE_POLICY=off`, `ATA_SKIP_UPDATE=1`,
 *   `new Client({ allowOutdated: true })`.
 *
 * This module is import-safe: importing it performs no network I/O.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";

import * as config from "./config.js";
import { UpdateCheckError, UpdateRequiredError } from "./errors.js";
import { logger } from "./logging.js";
import { redactUrl } from "./utils.js";
import { VERSION } from "./version.js";

export const REGISTRY_CHECK_URL = config.NPM_REGISTRY_URL;

// ---------------------------------------------------------------------------
// Update policy
// ---------------------------------------------------------------------------
export type UpdatePolicy = "strict" | "ask" | "warn" | "off";

export const UPDATE_POLICIES: readonly UpdatePolicy[] = ["strict", "ask", "warn", "off"];

/** Tolerant coercion from strings; `null` passes through as `fallback`. */
export function coerceUpdatePolicy(
  value: unknown,
  fallback: UpdatePolicy | null = null,
): UpdatePolicy | null {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim().toLowerCase();
  return (UPDATE_POLICIES as readonly string[]).includes(text) ? (text as UpdatePolicy) : fallback;
}

export class UpdateInfo {
  readonly installed: string;
  readonly latest: string | null;
  readonly isOutdated: boolean;
  readonly checkedAt: number;
  readonly source: string;
  /** False when the check failed / was offline (fail-open). */
  readonly known: boolean;

  constructor(
    installed: string,
    latest: string | null,
    isOutdated: boolean,
    checkedAt: number,
    source: string,
    known: boolean,
  ) {
    this.installed = installed;
    this.latest = latest;
    this.isOutdated = isOutdated;
    this.checkedAt = checkedAt;
    this.source = source;
    this.known = known;
  }

  toDict(): Record<string, unknown> {
    return {
      installed: this.installed,
      latest: this.latest,
      is_outdated: this.isOutdated,
      checked_at: this.checkedAt,
      source: this.source,
      known: this.known,
    };
  }
}

// ---------------------------------------------------------------------------
// Version comparison (PEP 440-ish, local, no dependency)
// ---------------------------------------------------------------------------
const VERSION_RE =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[._-]?(a|b|c|rc|alpha|beta|pre|preview)(?:[._-]?(\d+))?)?(?:[._-]?(post|rev|r)(?:[._-]?(\d+))?)?(?:[._-]?dev(?:[._-]?(\d+))?)?(?:\+.*)?\s*$/i;

const PRE_RANK: Record<string, number> = {
  a: 1,
  alpha: 1,
  b: 2,
  beta: 2,
  c: 3,
  pre: 3,
  preview: 3,
  rc: 3,
};

const RELEASE_PAD = 8;

type MainKey = [number, number[], number, number, number, number];
type VersionKey = [MainKey, number];

/**
 * Parse a version string into a sortable key.
 *
 * Returns `null` when the text is not a recognisable version, which makes
 * comparisons fail open (treated as equal) instead of crashing.
 */
export function parseVersion(text: string | null | undefined): VersionKey | null {
  if (text === null || text === undefined) return null;
  const match = VERSION_RE.exec(String(text));
  if (!match) return null;
  const epoch = Number.parseInt(match[1] ?? "0", 10) || 0;
  const releaseRaw = match[2] ?? "0";
  const release = releaseRaw.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const padded = [...release];
  while (padded.length < RELEASE_PAD) padded.push(0);

  const preLabel = (match[3] ?? "").toLowerCase();
  const preNum = Number.parseInt(match[4] ?? "0", 10) || 0;
  let stage: number;
  let stageRank: number;
  if (preLabel) {
    stage = 1;
    stageRank = PRE_RANK[preLabel] ?? 1;
  } else {
    stage = 2;
    stageRank = 0;
  }

  const postLabel = (match[5] ?? "").toLowerCase();
  const post = postLabel ? Number.parseInt(match[6] ?? "0", 10) || 0 : 0;
  const dev = Number.parseInt(match[7] ?? "0", 10) || 0;

  // A dev suffix on a final release sorts *before* the plain release.
  const effectiveStage = dev > 0 && !preLabel ? 0 : stage;
  return [[epoch, padded, effectiveStage, stageRank, preNum, post], dev];
}

/**
 * Compare two version strings PEP-440-style.
 *
 * Returns `-1` if `a < b`, `0` if equal/unparsable, `1` if `a > b`.
 * Unparsable versions fail open (equal) by design.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const keyA = parseVersion(a);
  const keyB = parseVersion(b);
  if (keyA === null || keyB === null) return 0;
  const [mainA, devA] = keyA;
  const [mainB, devB] = keyB;
  const mainCompare = compareArrays(mainA, mainB);
  if (mainCompare !== 0) return mainCompare < 0 ? -1 : 1;
  // Same main key: a dev build sorts below the plain release.
  if (devA !== devB) return devA > devB ? -1 : 1;
  return 0;
}

function compareArrays(a: MainKey, b: MainKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  // Padded release arrays compare component-wise.
  const releaseA = a[1];
  const releaseB = b[1];
  for (let j = 0; j < RELEASE_PAD; j += 1) {
    const av = releaseA[j] ?? 0;
    const bv = releaseB[j] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  for (const idx of [2, 3, 4, 5] as const) {
    if (a[idx] !== b[idx]) return (a[idx] ?? 0) < (b[idx] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** True when `latest` is strictly greater than `installed`. */
export function isOutdated(installed: string | null | undefined, latest: string | null | undefined): boolean {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}

// ---------------------------------------------------------------------------
// Registry check (single attempt, hard timeout, fail-open)
// ---------------------------------------------------------------------------
export type Fetcher = (checkUrl: string, timeout: number) => Promise<string | null>;

export async function fetchLatest(
  checkUrl: string = REGISTRY_CHECK_URL,
  timeout: number = config.UPDATE_CHECK_TIMEOUT,
): Promise<string | null> {
  try {
    const url = new URL(checkUrl);
    if (url.protocol !== "https:") return null;
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": config.DEFAULT_USER_AGENT,
            Accept: "application/json",
            "Accept-Encoding": "identity",
            Connection: "close",
          },
          timeout: timeout * 1000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1 << 20) {
              res.destroy();
              resolve("");
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", reject);
        },
      );
      req.setTimeout(timeout * 1000, () => {
        req.destroy(new Error("registry check timeout"));
      });
      req.on("error", reject);
      req.end();
    });
    if (!body) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return null;
    }
    // npm registry packument: { version: "x.y.z" }; PyPI-style: { info: { version } }.
    const record = payload as { version?: unknown; info?: { version?: unknown } };
    const version = record.version ?? record.info?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    // Fail-open by design: offline, DNS failure, 404, timeout, garbage.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------
export function cachePath(cacheDir?: string | null): string {
  const base = cacheDir ?? config.cacheDir();
  return path.join(base, ...config.UPDATE_CACHE_FILE.split("/"));
}

export function readCache(cacheDir?: string | null): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(cachePath(cacheDir), "utf-8"));
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      "checked_at" in (data as Record<string, unknown>)
    ) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* missing or corrupt */
  }
  return null;
}

export function writeCache(record: Record<string, unknown>, cacheDir?: string | null): boolean {
  const target = cachePath(cacheDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmpPath = target + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(record), "utf-8");
    fs.renameSync(tmpPath, target);
    return true;
  } catch {
    return false;
  }
}

export function resolvePolicy(explicit?: unknown): UpdatePolicy {
  const envPolicy = config.env(config.ENV_UPDATE_POLICY);
  const chosen = coerceUpdatePolicy(explicit, null);
  if (chosen === null && envPolicy) return coerceUpdatePolicy(envPolicy, null) ?? "strict";
  return chosen ?? "strict";
}

// ---------------------------------------------------------------------------
// One-check-per-process gate state
// ---------------------------------------------------------------------------
interface GateState {
  info: UpdateInfo | null;
  blocked: boolean;
  installedNow: boolean;
}

let gateState: GateState | null = null;
let gatePromise: Promise<GateState> | null = null;

/** Forget the in-process gate result (used by tests). */
export function resetGateState(): void {
  gateState = null;
  gatePromise = null;
}

export interface EnsureUsableOptions {
  policy?: unknown;
  allowOutdated?: boolean;
  interactive?: boolean | null;
  checkUrl?: string;
  cacheDir?: string | null;
  ttl?: number | null;
  now?: number | null;
  fetcher?: Fetcher | null;
  installer?: ((command: string[]) => Promise<{ code: number; output: string }>) | null;
  inputFn?: ((prompt: string) => Promise<string | null>) | null;
  printer?: ((text: string) => void) | null;
}

export async function installedVersion(fallback: string = VERSION): Promise<string | null> {
  // In Node the bundled constant is always authoritative and cheap.
  return fallback;
}

/**
 * Check the npm registry for a newer release, honouring the disk cache.
 *
 * Never throws for network problems; a failed check returns `known: false`
 * with `latest: null` (fail-open). Throws {@link UpdateCheckError} only when
 * the *installed* version cannot be determined.
 */
export async function checkForUpdate(
  force = false,
  installed?: string | null,
  opts: {
    checkUrl?: string;
    cacheDir?: string | null;
    ttl?: number | null;
    now?: number | null;
    fetcher?: Fetcher | null;
  } = {},
): Promise<UpdateInfo> {
  const installedVersionStr = installed ?? (await installedVersion());
  if (!installedVersionStr) {
    throw new UpdateCheckError(
      "Could not determine the installed SDK version; reinstall with: " +
        "npm install alltradingapi@latest",
    );
  }
  const ttlSeconds =
    opts.ttl ?? config.envFloat(config.ENV_UPDATE_TTL, config.UPDATE_CACHE_TTL);
  const current = opts.now ?? Date.now() / 1000;
  const fetch = opts.fetcher ?? fetchLatest;
  const checkUrl = opts.checkUrl ?? REGISTRY_CHECK_URL;

  if (
    !force &&
    gateState?.info instanceof UpdateInfo &&
    current - gateState.info.checkedAt < ttlSeconds
  ) {
    return gateState.info;
  }

  if (!force) {
    const cached = readCache(opts.cacheDir);
    if (cached) {
      let age = ttlSeconds + 1;
      const checkedAt = Number(cached["checked_at"]);
      if (Number.isFinite(checkedAt)) age = current - checkedAt;
      if (age < ttlSeconds) {
        const latest = typeof cached["latest"] === "string" ? cached["latest"] : null;
        return new UpdateInfo(
          installedVersionStr,
          latest,
          isOutdated(installedVersionStr, latest),
          checkedAt || 0,
          typeof cached["source"] === "string" ? cached["source"] : "cache",
          Boolean(latest),
        );
      }
    }
  }

  const latest = await fetch(checkUrl, config.UPDATE_CHECK_TIMEOUT);
  const checkedAt = current;
  const info = new UpdateInfo(
    installedVersionStr,
    latest,
    isOutdated(installedVersionStr, latest),
    checkedAt,
    "npm",
    Boolean(latest),
  );
  if (info.known) {
    writeCache({ checked_at: checkedAt, latest, source: "npm" }, opts.cacheDir);
    gateState = { info, blocked: gateState?.blocked ?? false, installedNow: false };
  }
  return info;
}

/** The exact command used (and printed on failure) to self-upgrade. */
export function upgradeCommand(): string[] {
  return ["npm", "install", "alltradingapi@latest"];
}

/** Run `npm install alltradingapi@latest` and report (ok, output tail). */
export async function installUpdate(
  opts: {
    installer?: ((command: string[]) => Promise<{ code: number; output: string }>) | null;
    timeout?: number;
  } = {},
): Promise<[boolean, string]> {
  const command = upgradeCommand();
  if (opts.installer) {
    const result = await opts.installer(command);
    return [result.code === 0, redactUrl(result.output ?? "") ?? ""];
  }
  try {
    const [command0, ...commandRest] = command;
    const completed = spawnSync(command0 ?? "npm", commandRest, {
      shell: process.platform === "win32",
      timeout: opts.timeout ?? 300_000,
      encoding: "utf-8",
    });
    const output = `${completed.stdout ?? ""}${completed.stderr ?? ""}`.trim();
    const tail = output.length > 800 ? output.slice(-800) : output;
    return [completed.status === 0, redactUrl(tail) ?? ""];
  } catch (err) {
    return [false, `npm failed: ${redactUrl(String(err))}`];
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------
async function timedInput(timeout = 30.0): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      resolve(null);
    }, timeout * 1000);
    rl.question("", (text) => {
      clearTimeout(timer);
      rl.close();
      resolve(text);
    });
    rl.on("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  return answer;
}

function printNotice(lines: string[], printer: (text: string) => void): void {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  printer("-".repeat(width));
  for (const line of lines) printer(line);
  printer("-".repeat(width));
}

async function runGate(
  installed: string,
  opts: EnsureUsableOptions,
): Promise<GateState> {
  const effective = resolvePolicy(opts.policy);
  const allowOutdated = opts.allowOutdated ?? false;
  const policy: UpdatePolicy =
    allowOutdated && (effective === "strict" || effective === "ask") ? "warn" : effective;

  if (policy === "off") return { info: null, blocked: false, installedNow: false };

  const info = await checkForUpdate(false, installed, {
    checkUrl: opts.checkUrl,
    cacheDir: opts.cacheDir,
    ttl: opts.ttl,
    now: opts.now ?? undefined,
    fetcher: opts.fetcher ?? undefined,
  });

  if (!info.isOutdated || !info.known) return { info, blocked: false, installedNow: false };

  const emit = opts.printer ?? ((text: string) => process.stderr.write(text + "\n"));
  const notify = (): void => {
    emit(
      `alltradingapi: a newer SDK is available ` +
        `(${info.installed} -> ${info.latest}). Run: npm install alltradingapi@latest`,
    );
  };

  if (policy === "warn") {
    logger.info(`update available: ${info.installed} -> ${info.latest} (policy=warn)`);
    notify();
    return { info, blocked: false, installedNow: false };
  }

  // strict / ask
  const isInteractiveMode = opts.interactive ?? config.isInteractive();
  logger.info(
    `update available: ${info.installed} -> ${info.latest} (policy=${policy} interactive=${isInteractiveMode})`,
  );

  if (isInteractiveMode) {
    const latestDisplay = info.latest ?? "unknown";
    printNotice(
      [
        `A newer All Trading API SDK is available: ${info.installed} -> ${latestDisplay}`,
        "This SDK requires the update to operate. Update now? [Y/n]",
      ],
      emit,
    );
    const reader = opts.inputFn ?? (async () => timedInput());
    const answer = ((await reader("")) ?? "").trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      const [ok, tail] = await installUpdate({ installer: opts.installer ?? undefined });
      if (ok) {
        emit(`Updated to ${info.latest}. Restart your program to load the new code.`);
        return { info, blocked: true, installedNow: true };
      }
      emit(
        "Automatic update failed. Update manually:\n" +
          "    npm install alltradingapi@latest\n" +
          `npm output tail:\n${tail}`,
      );
      return { info, blocked: true, installedNow: false };
    }
    // Declined
    if (policy === "ask") {
      logger.warn("update declined; continuing (policy=ask)");
      notify();
      return { info, blocked: false, installedNow: false };
    }
    return { info, blocked: true, installedNow: false };
  }

  // Non-interactive strict/ask: block immediately, never wait on stdin.
  return { info, blocked: true, installedNow: false };
}

/**
 * Run the update gate; resolve `UpdateInfo` when usable.
 *
 * Throws {@link UpdateRequiredError} when the strict gate blocks operation.
 * Runs at most one network check per process (cached afterwards).
 */
export async function ensureUsable(
  installed: string,
  opts: EnsureUsableOptions = {},
): Promise<UpdateInfo | null> {
  if (gateState) {
    if (gateState.blocked) throw buildError(gateState.info, false);
    return gateState.info;
  }

  if (config.envBool(config.ENV_SKIP_UPDATE)) return null;

  if (!gatePromise) gatePromise = runGate(installed, opts);
  let state: GateState;
  try {
    state = await gatePromise;
  } catch (err) {
    gatePromise = null;
    throw err;
  }
  gateState = state;
  gatePromise = null;
  if (state.blocked) throw buildError(state.info, state.installedNow);
  return state.info;
}

function buildError(info: UpdateInfo | null, installedNow: boolean): UpdateRequiredError {
  const latest = info?.latest ?? "the latest version";
  const current = info?.installed ?? "the installed version";
  if (installedNow) {
    return new UpdateRequiredError(
      `Updated to ${latest} successfully, but this process still runs the old ` +
        `code (${current}). Restart your program to load the updated SDK.`,
      { installed: current, latest: info?.latest ?? null, installedNow: true },
    );
  }
  return new UpdateRequiredError(
    `A newer All Trading API SDK is required: installed ${current} but ${latest} is ` +
      "available. This SDK refuses to operate when outdated.\n" +
      "Update now:\n" +
      "    npm install alltradingapi@latest\n" +
      "Escape hatches (documented, not silent): set ATA_UPDATE_POLICY=off, " +
      "ATA_SKIP_UPDATE=1, or pass new Client({ allowOutdated: true }).",
    { installed: current, latest: info?.latest ?? null, installedNow: false },
  );
}
