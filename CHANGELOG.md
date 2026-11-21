# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-21

Initial release — the Node/TypeScript sibling of
[`alltradingapi-python`](https://github.com/alltradingapi/alltradingapi-python).

### Added

- `Client` (and `AsyncClient` alias) covering all six v1 endpoints:
  `assets`, `candles`, `history`, `saved`, `screenshot`, `result`
- Zero-dependency transport on `node:http`/`node:https`: keep-alive pool,
  gzip/deflate decompression, browser-like User-Agent rotation,
  connect + read timeouts, 32 MiB response cap
- Bounded retries with exponential full-jitter backoff on 429/5xx and
  transient socket errors, honouring `Retry-After`; POST retries at most
  once and only on 5xx
- Strict client-side parameter validation for every documented endpoint
  parameter (names, types, ranges, enums, boolean serialisation)
- Typed models: `Asset`, `Candle`, `SavedCandles`, `TradeResult`, `APIObject`
  and the `TradeOutcome` enum
- Error hierarchy (`ALLError` + 12 subclasses) with redacted URLs, parsed
  payloads and actionable messages
- Key resolution: per-call → per-product → `default` → constructor →
  `ATA_API_KEY` → `ATA_KEY_<PRODUCT>` environment variables
- Bearer (default) and query auth modes
- In-memory TTL cache for the assets endpoint with `refresh` bypass
- Must-update gate against the npm registry (strict/ask/warn/off policies,
  6 h disk cache, `ATA_UPDATE_POLICY` / `ATA_SKIP_UPDATE` escape hatches)
- `scan()` fan-out helper with per-asset error isolation
- 85 tests against a real local HTTP fixture server; dual ESM/CJS build with
  bundled TypeScript declarations
