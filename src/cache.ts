/**
 * In-memory TTL cache.
 *
 * Used only for the cheap, slow-changing metadata endpoints (`assets()`) by
 * default. Candles and analysis are never cached client-side.
 */

interface Entry {
  expiresAt: number;
  value: unknown;
}

export class TTLCache {
  private readonly _ttl: number;
  private readonly _maxsize: number;
  private readonly _store = new Map<PropertyKey, Entry>();

  constructor(ttl = 60.0, maxsize = 128) {
    this._ttl = Math.max(0, ttl);
    this._maxsize = Math.max(1, Math.floor(maxsize));
  }

  /** Configured time-to-live in seconds. */
  get ttl(): number {
    return this._ttl;
  }

  /** Return the cached value, or `undefined` when missing/expired. */
  get(key: PropertyKey): unknown {
    const now = Date.now();
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store `value` under `key` for the configured TTL. */
  put(key: PropertyKey, value: unknown): void {
    if (this._ttl <= 0) return;
    const now = Date.now();
    if (this._store.size >= this._maxsize && !this._store.has(key)) {
      this._evictOldest();
    }
    this._store.set(key, { expiresAt: now + this._ttl * 1000, value });
  }

  /** Drop every entry. */
  clear(): void {
    this._store.clear();
  }

  get size(): number {
    return this._store.size;
  }

  private _evictOldest(): void {
    let oldestKey: PropertyKey | undefined;
    let oldestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this._store) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this._store.delete(oldestKey);
  }
}
