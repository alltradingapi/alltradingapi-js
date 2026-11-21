/**
 * Error hierarchy for the All Trading API SDK.
 *
 * Every error carries structured context (status, payload, redacted URL) and a
 * message that tells the user what to do next. API keys never appear in error
 * text, `toString()` or URLs.
 */

import type { RecordLike } from "./types.js";
import { redactUrl } from "./utils.js";

export class ALLError extends Error {
  /** Short machine-readable code (e.g. `rate_limited`). */
  code = "all_error";
  /** HTTP status code when the error came from a response. */
  status: number | null;
  /** Parsed JSON body of the failing response, when present. */
  payload: RecordLike;
  /** Request URL with any credentials redacted. */
  url: string | null;
  /** Server-provided request id when available. */
  requestId: string | null;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      payload?: RecordLike | null;
      url?: string | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.message = message;
    this.status = opts.status ?? null;
    this.payload = opts.payload ?? {};
    this.url = redactUrl(opts.url ?? null);
    this.requestId = opts.requestId ?? null;
  }

  /** Return a JSON-serialisable view (URL already key-redacted). */
  toDict(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      status: this.status,
      request_id: this.requestId,
      url: this.url,
      payload: this.payload,
    };
  }
}

/** The SDK was constructed or called with impossible configuration. */
export class ConfigurationError extends ALLError {
  override code = "configuration_error";
}

/** HTTP 401 — missing or invalid API key. */
export class AuthenticationError extends ALLError {
  override code = "authentication_error";
}

/** HTTP 403 — the key does not include this product, or is paused. */
export class PermissionDeniedError extends ALLError {
  override code = "permission_denied";
}

/** HTTP 404 — unknown route (the server only serves pretty routes). */
export class NotFoundError extends ALLError {
  override code = "not_found";
}

/** HTTP 400 — bad/missing/unknown parameter (rejected client-side or server-side). */
export class ValidationError extends ALLError {
  override code = "validation_error";
}

/** HTTP 429 — rate limit reached; `retryAfter` says when to retry. */
export class RateLimitError extends ALLError {
  override code = "rate_limited";
  retryAfter: number | null;

  constructor(
    message: string,
    opts: {
      retryAfter?: number | null;
      status?: number | null;
      payload?: RecordLike | null;
      url?: string | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message, opts);
    this.retryAfter = opts.retryAfter ?? null;
  }
}

/** HTTP 5xx — server error on the API side. */
export class ServerError extends ALLError {
  override code = "server_error";
}

/** HTTP 502 — market-feed failure or insufficient candles upstream. */
export class UpstreamError extends ServerError {
  override code = "upstream_error";
}

/** Network-level failure: DNS, TCP, TLS. */
export class TransportError extends ALLError {
  override code = "transport_error";
}

/** A request exceeded its timeout. */
export class TimeoutError extends ALLError {
  override code = "timeout";
}

/**
 * The installed SDK is outdated and the strict update gate blocked it.
 */
export class UpdateRequiredError extends ALLError {
  override code = "update_required";
  installed: string | null;
  latest: string | null;
  /** True when `npm install alltradingapi@latest` succeeded in-process; restart to load it. */
  installedNow: boolean;

  constructor(
    message: string,
    opts: {
      installed?: string | null;
      latest?: string | null;
      installedNow?: boolean;
    } = {},
  ) {
    super(message);
    this.installed = opts.installed ?? null;
    this.latest = opts.latest ?? null;
    this.installedNow = opts.installedNow ?? false;
  }
}

/** Raised only by `Client.checkUpdates` when local version config is invalid. */
export class UpdateCheckError extends ALLError {
  override code = "update_check_error";
}

/** A consistent, actionable hint used across update-related errors. */
export function updateHint(command = "npm install alltradingapi@latest"): string {
  return `Run: ${command}`;
}

type ErrorCtor<T extends ALLError> = new (
  message: string,
  opts?: { status?: number; payload?: RecordLike | null; url?: string },
) => T;

interface MappedError {
  hint: string;
  ctor: ErrorCtor<ALLError>;
  retryAfter?: boolean;
}

/** Map an HTTP response to the matching SDK error. */
export function errorFromResponse(
  status: number,
  body: Buffer | string,
  url: string,
  headers: Record<string, string> = {},
): ALLError {
  const rawHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) rawHeaders[k.toLowerCase()] = v;

  let serverText: string | null = null;
  let payload: RecordLike = {};
  try {
    const decoded: unknown = JSON.parse(body.toString("utf-8"));
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      payload = decoded as RecordLike;
      const err = (decoded as RecordLike).error;
      const msg = (decoded as RecordLike).message;
      serverText = typeof err === "string" ? err : typeof msg === "string" ? msg : null;
    }
  } catch {
    // non-JSON body — keep the empty payload
  }

  const msg = (hint: string): string => {
    if (serverText && serverText !== hint) return `${hint} (server: ${serverText})`;
    return hint;
  };

  let retryAfter: number | null = null;
  const retryAfterRaw = rawHeaders["retry-after"];
  if (retryAfterRaw !== undefined) {
    const parsed = Number.parseFloat(retryAfterRaw);
    if (Number.isFinite(parsed)) retryAfter = parsed;
  }

  const safeUrl = redactUrl(url) ?? url;
  const base = { status, payload, url: safeUrl };

  const table: Record<number, MappedError> = {
    400: {
      ctor: ValidationError,
      hint:
        "The request was rejected (400). Check parameter names, values " +
        "and ranges — this SDK validates documented parameters " +
        "client-side, so a 400 usually means the server-side set changed.",
    },
    401: {
      ctor: AuthenticationError,
      hint:
        "A valid API key is required (401). Pass apiKey=..., build " +
        "the client with a keys mapping, or set the ATA_API_KEY " +
        "environment variable for the product you are calling.",
    },
    403: {
      ctor: PermissionDeniedError,
      hint:
        "This API key does not include this product, or the " +
        "subscription is paused (403). Check your product " +
        "subscription — each product needs its own key.",
    },
    404: {
      ctor: NotFoundError,
      hint:
        "Unknown route (404). The server exposes pretty routes only " +
        "(e.g. /qx_candles); direct /api/*.php URLs are blocked by design.",
    },
    429: {
      ctor: RateLimitError,
      hint:
        "Rate limit reached (429). The SDK already honours Retry-After " +
        "and retries automatically; slow down your polling rate or " +
        "upgrade your plan.",
      retryAfter: true,
    },
    502: {
      ctor: UpstreamError,
      hint:
        "The market feed is unavailable upstream (502) or did not " +
        "return enough candles. The SDK retries automatically; if it " +
        "persists, the feed itself is down — try again shortly.",
    },
  };

  if (table[status]) {
    const entry = table[status];
    const opts = { ...base, ...(entry.retryAfter ? { retryAfter } : {}) };
    return new entry.ctor(msg(entry.hint), opts);
  }

  if (status >= 500 && status <= 599) {
    return new ServerError(
      msg(`Server error ${status} from the API. The SDK retries transient 5xx automatically.`),
      base,
    );
  }

  return new ALLError(msg(`Unexpected HTTP status ${status} from the API.`), base);
}
