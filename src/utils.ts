/**
 * Small shared helpers. Kept dependency-free and boring on purpose.
 */

export const REDACTED = "***";
const SECRET_QUERY_KEYS_RE = /([?&])(key|api_key|apikey|token)=([^&]+)/gi;
const BEARER_RE = /bearer\s+[ap0-9a-z_]+/gi;

export const ASSET_RE = /^[A-Za-z0-9_]{2,40}$/;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Return `url` with every credential removed or replaced by `***`.
 *
 * Safe to store in logs, exceptions and test assertions.
 */
export function redactUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  return url.replace(BEARER_RE, `Bearer ${REDACTED}`).replace(
    SECRET_QUERY_KEYS_RE,
    (_m, lead: string, name: string) => `${lead}${name}=${REDACTED}`,
  );
}

/** Strip whitespace for validation only; never silently upper-case. */
export function normalizeAsset(asset: string): string {
  return asset.trim();
}

/** True when `asset` matches the server's documented symbol regex. */
export function isValidAsset(asset: string): boolean {
  return ASSET_RE.test(normalizeAsset(asset));
}

/** True for `HH:MM` / `HH:MM:SS` clock strings. */
export function isValidTime(value: string): boolean {
  return TIME_RE.test(value.trim());
}

/** True for `YYYY-MM-DD` calendar strings. */
export function isValidDate(value: string): boolean {
  return DATE_RE.test(value.trim());
}

/** JSON-dump `data` on one line, truncated to `limit` characters. */
export function compactJson(data: unknown, limit = 400): string {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    text = String(data);
  }
  if (text === undefined) text = String(data);
  return truncateText(text, limit);
}

/** Hard-truncate `text` to at most `limit` characters with a size marker. */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const suffix = `…[${text.length} chars]`;
  return text.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

/** Serialise booleans the way the server expects: `true`/`false`. */
export function coerceBoolStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).toLowerCase();
}
