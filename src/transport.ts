/**
 * HTTP transport built on `node:http` / `node:https` — zero dependencies.
 *
 * Design notes:
 *
 * - Keep-alive connection pool (bounded idle connections per host).
 * - `Accept-Encoding: gzip, deflate` with transparent decompression.
 * - Explicit connect + read timeouts; no redirects (the API has none).
 * - Bounded retries with exponential backoff + **full jitter** on 429/5xx and
 *   transient socket errors; honours `Retry-After`.
 * - GET retries freely (idempotent); POST retries at most once and only on 5xx.
 * - Response size cap (32 MiB) so a hostile response cannot exhaust memory.
 * - TLS verification via Node defaults; `verify: false` is an explicit opt-in
 *   for local testing only.
 * - Optional proxy via `ATA_HTTP_PROXY` / `ATA_HTTPS_PROXY` (https goes through
 *   a CONNECT tunnel).
 * - API keys are redacted from URLs in logs and errors, always.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";

import * as config from "./config.js";
import {
  ALLError,
  ServerError,
  TimeoutError,
  TransportError,
  errorFromResponse,
} from "./errors.js";
import { httpDebugLine, logger } from "./logging.js";
import type { QueryParam } from "./types.js";
import { redactUrl } from "./utils.js";

/** Real browser User-Agents; one is picked at random per request so traffic
 * looks like everyday browser traffic rather than a script. */
export const BROWSER_USER_AGENTS: readonly string[] = [
  // Chrome on Windows 10/11
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  // Chrome on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // Edge on Windows / macOS
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  // Firefox on Windows / macOS / Linux
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  // Safari on macOS / iOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  // Chrome on Android
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
  "HPE_HEADER_OVERFLOW",
]);

/** Internal marker so our own timeouts are distinguishable from user aborts. */
class TimeoutSignal extends Error {}

export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof TimeoutSignal) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const message = err.message ?? "";
  return /socket hang up|other side closed|connection terminated|premature close/i.test(message);
}

/** A small, dependency-free HTTP response object. */
export class Response {
  readonly status: number;
  readonly headers: Record<string, string>;
  private readonly _body: Buffer;
  readonly url: string;
  readonly elapsedMs: number;

  constructor(
    status: number,
    headers: Record<string, string>,
    body: Buffer,
    url: string,
    elapsedMs: number,
  ) {
    this.status = status;
    this.headers = headers;
    this._body = body;
    this.url = url;
    this.elapsedMs = elapsedMs;
  }

  /** Body decoded as UTF-8 with replacement characters for bad sequences. */
  get text(): string {
    return this._body.toString("utf-8");
  }

  /** Parse the body as JSON (throws SyntaxError on non-JSON bodies). */
  json(): unknown {
    return JSON.parse(this.text);
  }

  get contentType(): string {
    return this.headers["content-type"] ?? "";
  }

  /** Raw body bytes. */
  get content(): Buffer {
    return this._body;
  }

  /** Case-insensitive header lookup. */
  header(name: string, fallback: string | null = null): string | null {
    return this.headers[name.toLowerCase()] ?? fallback;
  }
}

export interface RequestOptions {
  params?: QueryParam[] | null;
  body?: Buffer | null;
  headers?: Record<string, string> | null;
  /** Read timeout in seconds. */
  timeout?: number | null;
}

export interface TransportOptions {
  baseUrl?: string;
  connectTimeout?: number;
  maxRetries?: number;
  backoffFactor?: number;
  retryStatuses?: number[];
  verify?: boolean;
  userAgent?: string | null;
}

/** Low-level HTTP client used by `Client`. */
export class Transport {
  readonly baseUrl: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly prefix: string;
  readonly connectTimeout: number;
  readonly maxRetries: number;
  readonly backoffFactor: number;
  readonly retryStatuses: readonly number[];
  readonly verify: boolean;
  /** `null` -> a random browser User-Agent is picked per request. */
  readonly userAgent: string | null;

  private readonly _agentHttp: http.Agent;
  private readonly _agentHttps: https.Agent;
  private readonly _agentHttpProxy: http.Agent;
  private readonly _proxyHost: string;
  private readonly _proxyPort: number;
  private _lastSocket: net.Socket | null = null;

  constructor(opts: TransportOptions = {}) {
    const baseUrl = opts.baseUrl ?? config.BASE_URL;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("base_url must start with http:// or https://");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("base_url must start with http:// or https://");
    }
    this.baseUrl = baseUrl;
    this.scheme = parsed.protocol.replace(":", "");
    this.host = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    this.prefix = parsed.pathname.replace(/\/+$/, "");
    this.connectTimeout = opts.connectTimeout ?? config.DEFAULT_CONNECT_TIMEOUT;
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? config.DEFAULT_MAX_RETRIES));
    this.backoffFactor = Math.max(0, opts.backoffFactor ?? config.DEFAULT_BACKOFF_FACTOR);
    this.retryStatuses = [...(opts.retryStatuses ?? config.DEFAULT_RETRY_STATUSES)];
    this.verify = opts.verify ?? true;
    this.userAgent = opts.userAgent ?? null;

    const pool = { keepAlive: true, maxSockets: config.CONNECTION_POOL_SIZE, keepAliveMsecs: 30_000 };
    this._agentHttp = new http.Agent(pool);
    this._agentHttps = new https.Agent({ ...pool, rejectUnauthorized: this.verify });
    this._agentHttpProxy = new http.Agent(pool);
    const proxy = this._resolveProxy();
    this._proxyHost = proxy[0];
    this._proxyPort = proxy[1];
  }

  /** Perform `method` against `path` and return a `Response`. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const verb = method.toUpperCase();
    const readTimeoutMs =
      (opts.timeout !== undefined && opts.timeout !== null
        ? opts.timeout
        : config.DEFAULT_TIMEOUT) * 1000;
    const extraHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      extraHeaders[k.toLowerCase()] = v;
    }
    const url = this._buildUrl(path, opts.params ?? null);

    let attempt = 0;
    const maxAttempts = this.maxRetries + 1;
    let postRetriesUsed = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      let response: Response;
      try {
        response = await this._sendOnce(verb, url, extraHeaders, opts.body ?? null, readTimeoutMs);
      } catch (err) {
        lastError = err;
        this._discardConnection();
        if (this._shouldRetrySocket(verb, attempt, postRetriesUsed) && isRetryableNetworkError(err)) {
          postRetriesUsed += 1;
          await this._sleepBackoff(attempt);
          continue;
        }
        throw this._networkError(err, url);
      }

      const { status } = response;
      logger.debug(
        httpDebugLine(verb, url, { status, elapsedMs: response.elapsedMs, attempt }),
      );
      if (status < 400) return response;

      // Error statuses are mapped to SDK errors; some are retried.
      if (this._shouldRetryStatus(verb, status, attempt, postRetriesUsed)) {
        postRetriesUsed += 1;
        lastError = null;
        await this._sleepBackoff(attempt, response.header("retry-after"));
        continue;
      }

      throw errorFromResponse(status, response.content, url, response.headers);
    }

    if (lastError !== null) throw this._networkError(lastError, url);
    // Unreachable in practice; defensive.
    throw new ServerError(`Request failed after ${maxAttempts} attempts.`, {
      url: redactUrl(url) ?? url,
    });
  }

  /** Close pooled connections. Safe to call multiple times. */
  close(): void {
    for (const agent of [this._agentHttp, this._agentHttps, this._agentHttpProxy]) {
      agent.destroy();
    }
  }

  // -- internals ---------------------------------------------------------
  private _resolveProxy(): [string, number] {
    const raw = config.env(config.ENV_HTTPS_PROXY) || config.env(config.ENV_HTTP_PROXY);
    if (!raw) return ["", 0];
    const cleaned = raw.split("://").pop()!.replace(/\/+$/, "");
    const [host, portS] = cleaned.split(":");
    if (!host) return ["", 0];
    const port = portS !== undefined ? Number.parseInt(portS, 10) : NaN;
    return [host, Number.isFinite(port) ? port : 80];
  }

  private _buildUrl(path: string, params: QueryParam[] | null): string {
    let url = this.prefix + path;
    if (params && params.length > 0) {
      const search = new URLSearchParams();
      for (const [name, value] of params) search.append(name, value);
      url = url + "?" + search.toString();
    }
    return url;
  }

  private async _sendOnce(
    verb: string,
    url: string,
    extraHeaders: Record<string, string>,
    body: Buffer | null,
    readTimeoutMs: number,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent":
        this.userAgent ??
        BROWSER_USER_AGENTS[Math.floor(Math.random() * BROWSER_USER_AGENTS.length)] ??
        "alltradingapi-js",
      "Accept-Encoding": "gzip, deflate",
      Accept: "application/json, image/png, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      ...extraHeaders,
    };
    if (body !== null) {
      if (!("content-length" in headers)) headers["content-length"] = String(body.length);
      headers["content-type"] = headers["content-type"] ?? "application/octet-stream";
    }

    const started = performance.now();
    const raw = await this._rawRequest(verb, url, headers, body, readTimeoutMs);
    let data = await this._readBounded(raw, url);
    const elapsed = performance.now() - started;

    const encoding = (raw.headers["content-encoding"] ?? "").toLowerCase();
    if (encoding === "gzip" && data.subarray(0, 2).toString("latin1") === "\x1f\x8b") {
      try {
        data = zlib.gunzipSync(data);
      } catch {
        /* keep original bytes */
      }
    } else if (encoding === "deflate") {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.inflateRawSync(data);
        } catch {
          /* keep original bytes */
        }
      }
    }

    const headerDict: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (value === undefined) continue;
      headerDict[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    // Expose the *decompressed* length so callers can reason about size.
    headerDict["content-length"] = String(data.length);
    return new Response(raw.statusCode ?? 0, headerDict, data, url, elapsed);
  }

  private _rawRequest(
    verb: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | null,
    readTimeoutMs: number,
  ): Promise<http.IncomingMessage> {
    const connectTimeoutMs = this.connectTimeout * 1000;
    const useProxy = this._proxyHost !== "" && this.scheme === "https";

    if (this._proxyHost !== "" && this.scheme === "http") {
      // Plain HTTP via a forward proxy: absolute-URI request line.
      const absolute = `http://${this.host}:${this.port}${url}`;
      return new Promise((resolve, reject) => {
        const req = http.request(
          absolute,
          {
            method: verb,
            headers,
            agent: this._agentHttpProxy,
            timeout: readTimeoutMs,
          },
          resolve,
        );
        this._wireErrors(req, connectTimeoutMs, readTimeoutMs, reject);
        req.end(body ?? undefined);
      });
    }

    if (useProxy) {
      // HTTPS via CONNECT tunnel; a fresh tunnel per request (opt-in path).
      return this._tunnel().then((tunnelSocket) => {
        const tlsSocket = tls.connect({
          socket: tunnelSocket,
          servername: this.host,
          rejectUnauthorized: this.verify,
        });
        return new Promise((resolve, reject) => {
          const req = https.request(
            {
              host: this.host,
              port: this.port,
              method: verb,
              path: url,
              headers,
              agent: false,
              createConnection: () => tlsSocket,
              timeout: readTimeoutMs,
            },
            resolve,
          );
          this._wireErrors(req, connectTimeoutMs, readTimeoutMs, reject);
          req.end(body ?? undefined);
        });
      });
    }

    const lib = this.scheme === "https" ? https : http;
    const agent = this.scheme === "https" ? this._agentHttps : this._agentHttp;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: this.host,
          port: this.port,
          method: verb,
          path: url,
          headers,
          agent,
          timeout: readTimeoutMs,
        },
        resolve,
      );
      this._wireErrors(req, connectTimeoutMs, readTimeoutMs, reject);
      req.end(body ?? undefined);
    });
  }

  private _wireErrors(
    req: http.ClientRequest,
    connectTimeoutMs: number,
    readTimeoutMs: number,
    reject: (err: Error) => void,
  ): void {
    req.on("socket", (socket) => {
      this._lastSocket = socket;
      if (socket.connecting) {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new TimeoutSignal("connect timeout"));
        }, connectTimeoutMs);
        socket.once("connect", () => clearTimeout(timer));
        socket.once("error", () => clearTimeout(timer));
        socket.once("secureConnect", () => clearTimeout(timer));
      }
    });
    req.setTimeout(readTimeoutMs, () => {
      req.destroy(new TimeoutSignal("read timeout"));
    });
    req.on("error", (err) => reject(err));
  }

  private _tunnel(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this._proxyHost, port: this._proxyPort });
      socket.setTimeout(this.connectTimeout * 1000, () => {
        socket.destroy();
        reject(new TimeoutSignal("proxy connect timeout"));
      });
      socket.once("error", (err) => reject(err));
      socket.once("connect", () => {
        socket.write(`CONNECT ${this.host}:${this.port} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n\r\n`);
      });
      let buffer = "";
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onData);
        socket.setTimeout(0);
        if (/^HTTP\/1\.[01] 200/.test(buffer)) {
          // If the proxy already forwarded body bytes, push them back.
          const rest = buffer.slice(end + 4);
          if (rest) socket.unshift(Buffer.from(rest, "latin1"));
          resolve(socket);
        } else {
          socket.destroy();
          reject(new TransportError(`Proxy CONNECT failed: ${buffer.split("\r\n")[0]}`));
        }
      };
      socket.on("data", onData);
    });
  }

  private async _readBounded(
    raw: http.IncomingMessage,
    url: string,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of raw) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > config.MAX_RESPONSE_BYTES) {
        raw.destroy();
        throw new TransportError(
          `Response exceeded the ${Math.floor(config.MAX_RESPONSE_BYTES / (1024 * 1024))} MiB safety cap; ` +
            "refusing to load it into memory.",
          { url: redactUrl(url) ?? url },
        );
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private _shouldRetrySocket(verb: string, attempt: number, postRetriesUsed: number): boolean {
    if (verb === "POST") return postRetriesUsed < 1;
    return attempt < this.maxAttempts;
  }

  private _shouldRetryStatus(
    verb: string,
    status: number,
    attempt: number,
    postRetriesUsed: number,
  ): boolean {
    if (!this.retryStatuses.includes(status)) return false;
    if (verb === "POST") return status >= 500 && postRetriesUsed < 1;
    return attempt < this.maxAttempts;
  }

  private get maxAttempts(): number {
    return this.maxRetries + 1;
  }

  private async _sleepBackoff(attempt: number, retryAfter: string | null = null): Promise<void> {
    const delay = this._backoffDelay(attempt, retryAfter);
    if (delay > 0) {
      logger.warn(`Retrying in ${delay.toFixed(2)}s (attempt ${attempt + 1})`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
  }

  private _backoffDelay(attempt: number, retryAfter: string | null = null): number {
    if (retryAfter !== null) {
      const parsed = Number.parseFloat(retryAfter);
      if (Number.isFinite(parsed)) return Math.min(Math.max(0, parsed), 30);
    }
    const base = this.backoffFactor * 2 ** (attempt - 1);
    return Math.random() * base; // full jitter
  }

  private _networkError(err: unknown, url: string): ALLError {
    if (err instanceof TimeoutSignal || (err instanceof Error && err.message.includes("timeout"))) {
      return new TimeoutError(
        "Request timed out. Every request carries a timeout so nothing " +
          "hangs; raise Client({ timeout: ... }) if the endpoint is slow.",
        { url: redactUrl(url) ?? url },
      );
    }
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new TransportError(
      `Network error: ${detail}. Check connectivity; the SDK retries ` +
        "transient socket errors automatically.",
      { url: redactUrl(url) ?? url },
    );
  }

  private _discardConnection(): void {
    // Drop only the socket this transport just used, so concurrent requests
    // keep their pooled connections.
    if (this._lastSocket && !this._lastSocket.destroyed) {
      this._lastSocket.destroy();
    }
    this._lastSocket = null;
  }
}
