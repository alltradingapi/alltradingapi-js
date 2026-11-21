<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/alltradingapi/alltradingapi-js@v1.0.0/assets/hero.svg" alt="All Trading API" width="100%">
</p>

# alltradingapi

JavaScript/TypeScript client for the [All Trading API](https://alltradingapi.com) —
candles, assets, saved candles, candle history, chart images and trade result
checks for Quotex. The Node sibling of
[`alltradingapi-python`](https://github.com/alltradingapi/alltradingapi-python).

- Zero dependencies — Node built-ins only, ESM + CJS, ships TypeScript types
- Automatic retries on rate limits and server errors, honouring `Retry-After`
- Strict client-side parameter validation (saves a round trip)
- Node 18+

| | |
|---|---|
| [![npm](https://img.shields.io/npm/v/alltradingapi.svg?v=1.0.0)](https://www.npmjs.com/package/alltradingapi) | [![Node](https://img.shields.io/node/v/alltradingapi.svg?v=1.0.0)](https://www.npmjs.com/package/alltradingapi) |
| [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) | |

## Install

```
npm install alltradingapi
```

Get an API key from [alltradingapi.com](https://alltradingapi.com). Each
endpoint type has its own key. The simplest setup is one default key:

```
export ATA_API_KEY=ap_yourkey
```

You can also pass keys per product, or per call — see
[authentication](#authentication).

## Quickstart

```js
import { Client } from "alltradingapi";

const ata = new Client(); // uses ATA_API_KEY

const assets = await ata.assets({ onlyOpen: true });
console.log("open assets:", assets.length);

const candles = await ata.candles("EURUSD_otc", { hours: 2, timeframe: "1m" });
console.log("last close:", candles[candles.length - 1].close);

ata.close();
```

## Endpoints

| method | endpoint | returns |
|---|---|---|
| `ata.assets()` | `/qx_assets` | list of assets with open state and payouts |
| `ata.candles(asset)` | `/qx_candles` | current candles (OHLC) |
| `ata.history(asset)` | `/qx_history` | candle history |
| `ata.saved(asset)` | `/qx_saved` | saved candles from the archive |
| `ata.screenshot(asset)` | `/qx_ss_pro_v2` | chart image as PNG bytes |
| `ata.result(asset, { time, direction })` | `/qx_result` | trade result check |

Common options: `timeframe` (`5s`…`4h`), `timezone` (`"-3"`, `"UTC"`,
`"Asia/Dhaka"`, …), `hours` (1–24), `count` (1–1000 for saved candles).
Invalid values raise `ValidationError` before any request is sent.

## Saving a chart image

```js
import { writeFile } from "node:fs/promises";

const png = await ata.screenshot("EURUSD_otc", { timeframe: "1m" });
await writeFile("chart.png", png); // real PNG, 1200x680, returned by the API
```

## Result check

```js
const outcome = await ata.result("EURUSD_otc", { time: "20:00", direction: "call", mtg: 1 });
console.log(outcome.result); // "win" / "lose" / "refund" / "pending" / ...
console.log(outcome.won);    // true for win / win1 / win2
```

## Fan-out scan

```js
// candles for many assets at once; failures stay per-asset
const results = await ata.scan(["EURUSD_otc", "GBPUSD_otc", "BRLUSD_otc"], {
  hours: 1,
  concurrency: 3,
});
for (const [symbol, value] of Object.entries(results)) {
  if (value instanceof Error) console.log(symbol, "failed");
  else console.log(symbol, value.length, "candles");
}
```

## TypeScript

The package ships its own types — no `@types` install needed:

```ts
import { Client, Candle } from "alltradingapi";

const ata = new Client({ apiKey: process.env.ATA_API_KEY });
const candles: Candle[] = await ata.candles("EURUSD_otc");
```

## Authentication

Keys are sent as a bearer header by default. Resolution order:

1. per-call `apiKey` option
2. `new Client({ keys: { "quotex-quotes": "ap_..." } })`
3. `new Client({ keys: { default: "ap_..." } })`
4. `new Client({ apiKey: "ap_..." })`
5. `ATA_API_KEY` environment variable
6. per-product `ATA_KEY_QUOTEX_QUOTES`, `ATA_KEY_QUOTEX_ASSETS`, etc.

Use `authMode: "query"` if you prefer `?key=` in the URL instead.

## Errors and retries

429 and 5xx responses are retried automatically with full-jitter backoff,
honouring `Retry-After`. After the retries are exhausted you get a specific
error:

```js
import {
  AuthenticationError, PermissionDeniedError,
  RateLimitError, UpstreamError, ValidationError,
} from "alltradingapi";

try {
  const candles = await ata.candles("EURUSD_otc");
} catch (err) {
  if (err instanceof RateLimitError) console.log("slow down, retry after", err.retryAfter, "s");
  else if (err instanceof ValidationError) console.log("bad parameter:", err.message);
  else if (err instanceof UpstreamError) console.log("feed is down, try again later");
}
```

Every error carries `.status`, `.message`, `.payload` and a redacted `.url`.
API keys never appear in error text or URLs.

## Staying up to date

The client checks the npm registry once per process and refuses to run if a
newer version exists, unless you opt out:

```js
const ata = new Client({ updatePolicy: "warn" }); // strict (default) | ask | warn | off
```

Escape hatches: `ATA_UPDATE_POLICY=off`, `ATA_SKIP_UPDATE=1`,
`new Client({ allowOutdated: true })`. Check without gating:
`await ata.checkUpdates(true)`.

## More examples

See the [examples/](examples/) folder: quickstart, candle history with a
sparkline, and chart images with async scanning.

## License & disclaimer

MIT — see [LICENSE](LICENSE). © 2026 All Trading API.

Independent, unofficial API. Not affiliated with, endorsed by, or connected
to Quotex. Trading involves substantial risk. This SDK provides market data
only — it cannot place trades and is not financial advice.
