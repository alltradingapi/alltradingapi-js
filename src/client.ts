/**
 * The `Client` — typed access to the six v1 endpoints.
 *
 * Endpoints covered:
 *
 * - `assets()`      -> `/qx_assets`     (asset data)
 * - `candles()`     -> `/qx_candles`    (current candles)
 * - `history()`     -> `/qx_history`    (candle history)
 * - `saved()`       -> `/qx_saved`      (saved candles)
 * - `screenshot()`  -> `/qx_ss_pro_v2`  (chart image, PNG bytes)
 * - `result()`      -> `/qx_result`     (trade result check)
 *
 * Key resolution order (first hit wins):
 *
 * 1. explicit per-call `apiKey`
 * 2. `keys[product]` (product id such as `"quotex-quotes"`)
 * 3. `keys["default"]`
 * 4. constructor `apiKey`
 * 5. environment `ATA_API_KEY`
 * 6. environment `ATA_KEY_<PRODUCT_UPPER_SNAKE>` (e.g. `ATA_KEY_QUOTEX_QUOTES`)
 *
 * If nothing resolves, calls throw `AuthenticationError` with an actionable
 * message — never a bare `undefined` key.
 */

import * as config from "./config.js";
import { VERSION } from "./version.js";
import { TTLCache } from "./cache.js";
import { ALLError, AuthenticationError, ConfigurationError } from "./errors.js";
import { logger } from "./logging.js";
import { Asset } from "./models/asset.js";
import { Candle } from "./models/candle.js";
import { SavedCandles } from "./models/candle.js";
import { TradeResult } from "./models/tradeResult.js";
import { validateParams } from "./params.js";
import { Response, Transport } from "./transport.js";
import type { QueryParam } from "./types.js";
import * as update from "./update.js";
import type { UpdateInfo, UpdatePolicy } from "./update.js";
import { redactUrl } from "./utils.js";

export type { UpdateInfo, UpdatePolicy };

export type UpdateCallback = (info: UpdateInfo) => void | Promise<void>;

export interface ClientOptions {
  apiKey?: string;
  keys?: Record<string, string>;
  baseUrl?: string;
  /** Read timeout in seconds. */
  timeout?: number;
  /** Connect timeout in seconds. */
  connectTimeout?: number;
  maxRetries?: number;
  backoffFactor?: number;
  retryStatuses?: number[];
  userAgent?: string | null;
  authMode?: "bearer" | "query";
  cacheTtl?: number;
  updatePolicy?: UpdatePolicy | string;
  allowOutdated?: boolean;
  interactive?: boolean | null;
  transport?: Transport;
  runUpdateGate?: boolean;
  /** Concurrent requests used by `scan()`. */
  maxConcurrency?: number;
}

export interface AssetsOptions {
  onlyOpen?: boolean;
  refresh?: boolean;
  account?: number | null;
  apiKey?: string;
}

export interface CandleOptions {
  hours?: number | null;
  timeframe?: string | null;
  timezone?: string | null;
  offset?: number | null;
  timestamp?: number | null;
  period?: number | null;
  account?: number | null;
  /** Server-side hint at feed latency; the SDK pads transport timeout by 5 s. */
  timeout?: number | null;
  verboseLogging?: boolean | null;
  apiKey?: string;
}

export interface SavedOptions {
  timeframe?: string | null;
  count?: number | null;
  timezone?: string | null;
  raw?: boolean | null;
  nocache?: boolean;
  apiKey?: string;
}

export interface ScreenshotOptions {
  timeframe?: string | null;
  timezone?: string | null;
  time?: string | null;
  result?: string | null;
  names?: string | null;
  apiKey?: string;
}

export interface ResultOptions {
  time: string;
  direction: string;
  timeframe?: string | null;
  timezone?: string | null;
  mtg?: number | null;
  apiKey?: string;
}

export interface ScanOptions {
  concurrency?: number;
  apiKey?: string;
}

const ROUTES: Record<string, string> = {
  assets: "/qx_assets",
  candles: "/qx_candles",
  history: "/qx_history",
  saved: "/qx_saved",
  screenshot: "/qx_ss_pro_v2",
  result: "/qx_result",
};

/** Which product id (and therefore which key) each call needs. */
const PRODUCTS: Record<string, string> = {
  assets: "quotex-assets",
  candles: "quotex-quotes",
  history: "quotex-realtime",
  saved: "quotex-saved",
  screenshot: "quotex-screenshots",
  result: "quotex-results",
};

export class Client {
  private _keys: Record<string, string> = {};
  private _authMode: "bearer" | "query";
  private _cacheTtl: number;
  private _cache: TTLCache;
  private _updatePolicy: UpdatePolicy | string | undefined;
  private _allowOutdated: boolean;
  private _interactive: boolean | null;
  private _updateHooks: UpdateCallback[] = [];
  private _gatePromise: Promise<void> | null = null;
  private _maxConcurrency: number;
  protected _transport: Transport;
  protected _closed = false;

  constructor(options: ClientOptions = {}) {
    const authMode = options.authMode ?? config.DEFAULT_AUTH_MODE;
    if (authMode !== "bearer" && authMode !== "query") {
      throw new ConfigurationError(
        "authMode must be 'bearer' (recommended: keeps keys out of URLs and logs) or 'query'.",
      );
    }
    if (options.keys) {
      for (const [product, key] of Object.entries(options.keys)) {
        if (!key) continue;
        this._keys[product] = key;
      }
    }
    if (options.apiKey) this._keys["__constructor__"] = options.apiKey;
    this._authMode = authMode;
    this._cacheTtl = options.cacheTtl ?? config.DEFAULT_CACHE_TTL;
    this._cache = new TTLCache(this._cacheTtl);
    this._updatePolicy = options.updatePolicy;
    this._allowOutdated = options.allowOutdated ?? false;
    this._interactive = options.interactive ?? null;
    this._maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 8));

    this._transport =
      options.transport ??
      new Transport({
        baseUrl: options.baseUrl ?? config.BASE_URL,
        connectTimeout: options.connectTimeout,
        maxRetries: options.maxRetries,
        backoffFactor: options.backoffFactor,
        retryStatuses: options.retryStatuses,
        userAgent: options.userAgent ?? null,
      });
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------
  /** Build a client from environment configuration (ATA_* variables). */
  static fromEnv(options: ClientOptions = {}): Client {
    return new Client({
      ...options,
      apiKey: options.apiKey ?? process.env[config.ENV_API_KEY] ?? undefined,
    });
  }

  close(): void {
    if (!this._closed) {
      this._transport.close();
      this._closed = true;
    }
  }

  // ------------------------------------------------------------------
  // Update gate & info
  // ------------------------------------------------------------------
  /** Installed SDK version string. */
  get version(): string {
    return VERSION;
  }

  private _runGate(): Promise<void> {
    if (!this._gatePromise) {
      this._gatePromise = update
        .ensureUsable(this.version, {
          policy: this._updatePolicy,
          allowOutdated: this._allowOutdated,
          interactive: this._interactive,
        })
        .then((info) => {
          if (info !== null && info.isOutdated) {
            for (const hook of this._updateHooks) {
              Promise.resolve()
                .then(() => hook(info))
                .catch((err) => logger.debug(`update hook raised: ${String(err)}`));
            }
          }
        })
        .catch((err) => {
          this._gatePromise = null;
          throw err;
        });
    }
    return this._gatePromise;
  }

  /** Register a callback receiving `UpdateInfo` when a newer SDK exists. */
  onUpdateAvailable(callback: UpdateCallback): void {
    this._updateHooks.push(callback);
  }

  /** Return `UpdateInfo`; never throws for network issues. */
  async checkUpdates(force = false): Promise<UpdateInfo> {
    try {
      return await update.checkForUpdate(force, this.version);
    } catch (err) {
      if (err instanceof ALLError) throw err;
      logger.debug(`update check failed: ${String(err)}`);
      return new update.UpdateInfo(this.version, null, false, 0, "error", false);
    }
  }

  // ------------------------------------------------------------------
  // Key resolution
  // ------------------------------------------------------------------
  private _resolveKey(call: string, apiKey?: string): string {
    if (apiKey) return apiKey;
    const product = PRODUCTS[call];
    if (product !== undefined && Object.hasOwn(this._keys, product)) {
      return this._keys[product]!; // existence checked above
    }
    if (Object.hasOwn(this._keys, "default")) return this._keys["default"]!;
    if (Object.hasOwn(this._keys, "__constructor__")) return this._keys["__constructor__"]!;
    const envDefault = process.env[config.ENV_API_KEY];
    if (envDefault) return envDefault;
    if (product !== undefined) {
      const envProduct =
        process.env[config.ENV_KEY_PREFIX + product.toUpperCase().replace(/-/g, "_")];
      if (envProduct) return envProduct;
    }
    throw new AuthenticationError(
      `No API key available for '${call}'. Pass apiKey=..., build the client ` +
        `with keys={{ '${product ?? "default"}': 'ap_...' }}, or set the environment variable ` +
        `ATA_API_KEY (or ATA_KEY_${(product ?? "DEFAULT").toUpperCase().replace(/-/g, "_")}). ` +
        "Each product needs its own key from https://alltradingapi.com.",
    );
  }

  private async _request(
    call: string,
    opts: {
      method?: string;
      params?: QueryParam[];
      headers?: Record<string, string>;
      apiKey?: string;
      timeout?: number | null;
    } = {},
  ): Promise<Response> {
    await this._runGate();
    const key = this._resolveKey(call, opts.apiKey);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const query: QueryParam[] = [...(opts.params ?? [])];
    if (this._authMode === "bearer") {
      headers["Authorization"] = `Bearer ${key}`;
    } else {
      query.push(["key", key]);
    }
    const path = ROUTES[call];
    if (path === undefined) {
      throw new ConfigurationError(`Unknown endpoint '${call}'.`);
    }
    return this._transport.request(opts.method ?? "GET", path, {
      params: query,
      headers,
      timeout: opts.timeout ?? null,
    });
  }

  private async _cachedJson(
    cacheKey: string,
    call: string,
    opts: { refresh?: boolean; params?: QueryParam[]; apiKey?: string },
  ): Promise<unknown> {
    if (!opts.refresh) {
      const hit = this._cache.get(cacheKey);
      if (hit !== undefined) return hit;
    }
    const response = await this._request(call, { params: opts.params, apiKey: opts.apiKey });
    const payload = response.json();
    this._cache.put(cacheKey, payload);
    return payload;
  }

  /** Drop all client-side cached responses. */
  clearCache(): void {
    this._cache.clear();
  }

  // ------------------------------------------------------------------
  // Asset data
  // ------------------------------------------------------------------
  /** List every tradable asset with open/closed state and payouts. */
  async assets(options: AssetsOptions = {}): Promise<Asset[]> {
    const { onlyOpen = false, refresh = false, account = null, apiKey } = options;
    const params = validateParams("assets", { account });
    const key = ["assets", JSON.stringify(params), String(refresh), this._authMode].join("\u0000");
    const payload = await this._cachedJson(key, "assets", { refresh, params, apiKey });
    const rows = Array.isArray(payload) ? payload : [];
    let assets = Asset.fromRows(rows);
    if (onlyOpen) assets = assets.filter((a) => a.isOpen);
    return assets;
  }

  // ------------------------------------------------------------------
  // Candles
  // ------------------------------------------------------------------
  /** Fetch recent candles for `asset` (default ~2h of 1m bars). */
  candles(asset: string, options: CandleOptions = {}): Promise<Candle[]> {
    return this._candles("candles", asset, options);
  }

  /** Fetch candle history for `asset` (same parameters as candles). */
  history(asset: string, options: CandleOptions = {}): Promise<Candle[]> {
    return this._candles("history", asset, options);
  }

  private async _candles(call: string, asset: string, options: CandleOptions): Promise<Candle[]> {
    const { apiKey, verboseLogging, ...rest } = options;
    const params = validateParams(call, {
      asset,
      ...rest,
      verbose_logging: verboseLogging,
    });
    const response = await this._request(call, {
      params,
      apiKey,
      timeout: effectiveTimeout(rest.timeout),
    });
    const rows = response.json();
    return Candle.fromRows(Array.isArray(rows) ? rows : []);
  }

  // ------------------------------------------------------------------
  // Saved candles
  // ------------------------------------------------------------------
  /** Fetch server-side saved candles (scanned from the 5s archive). */
  async saved(asset: string, options: SavedOptions = {}): Promise<SavedCandles> {
    const { apiKey, ...rest } = options;
    const params = validateParams("saved", { asset, ...rest });
    const response = await this._request("saved", { params, apiKey });
    return SavedCandles.fromPayload(response.json());
  }

  // ------------------------------------------------------------------
  // Chart screenshots
  // ------------------------------------------------------------------
  /** Download a chart screenshot (PNG bytes) for `asset`. */
  async screenshot(asset: string, options: ScreenshotOptions = {}): Promise<Buffer> {
    const { apiKey, ...rest } = options;
    const params = validateParams("screenshot", { asset, ...rest });
    const response = await this._request("screenshot", { params, apiKey });
    if (!response.contentType.startsWith("image/")) {
      throw new ALLError(
        `Expected an image from /qx_ss_pro_v2 but got Content-Type ` +
          `'${response.contentType}' (status ${response.status}). The server may have ` +
          "returned an error; check the asset/time parameter values.",
        { status: response.status, url: redactUrl(response.url) ?? response.url },
      );
    }
    return response.content;
  }

  // ------------------------------------------------------------------
  // Trade result
  // ------------------------------------------------------------------
  /** Check a past trade entry (call/put at HH:MM) and its outcome(s). */
  async result(asset: string, options: ResultOptions): Promise<TradeResult> {
    const { apiKey, ...rest } = options;
    const params = validateParams("result", { asset, ...rest });
    const response = await this._request("result", { params, apiKey });
    return new TradeResult(response.json());
  }

  // ------------------------------------------------------------------
  // Fan-out
  // ------------------------------------------------------------------
  /**
   * Fetch candles for many assets concurrently; per-asset failures never
   * abort. Returns `{ [symbol]: Candle[] | Error }`.
   */
  async scan(
    symbols: Iterable<string>,
    options: ScanOptions & Partial<CandleOptions> = {},
  ): Promise<Record<string, Candle[] | Error>> {
    const list = [...symbols];
    const { concurrency, ...candleOptions } = options;
    const limit = Math.max(1, Math.min(this._maxConcurrency, concurrency ?? this._maxConcurrency));
    const results: Record<string, Candle[] | Error> = {};
    let index = 0;

    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(limit, list.length); w += 1) {
      workers.push(
        (async () => {
          while (index < list.length) {
            const current = index;
            index += 1;
            const symbol = list[current];
            if (symbol === undefined) break;
            try {
              results[symbol] = await this.candles(symbol, candleOptions);
            } catch (err) {
              results[symbol] = err instanceof Error ? err : new Error(String(err));
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** The server-side 'timeout' param hints at feed latency; pad for transport. */
function effectiveTimeout(paramTimeout: number | null | undefined): number | null {
  if (paramTimeout === null || paramTimeout === undefined) return null;
  return paramTimeout + 5.0;
}

/** Async SDK client — same surface as `Client` (all methods promise-based). */
export class AsyncClient extends Client {}
