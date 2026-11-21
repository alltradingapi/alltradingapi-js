/**
 * Chart screenshots, trade result checks, and a concurrent candle scan.
 *
 * Run:
 *   npm install alltradingapi   (or: npm install && npm run build && npm link)
 *   node examples/03_charts_results_async.mjs
 *
 * Requires ATA_API_KEY (chart image needs the screenshots product key when
 * using per-product keys).
 */

import { writeFile } from "node:fs/promises";
import { Client } from "alltradingapi";

const key = process.env.ATA_API_KEY ?? "";
if (!key) {
  console.error("Set ATA_API_KEY first.");
  process.exit(1);
}

const ata = new Client({ apiKey: key, maxConcurrency: 6 });
try {
  // chart image for one asset
  const png = await ata.screenshot("EURUSD_otc", { timeframe: "1m" });
  await writeFile("chart.png", png);
  console.log(`saved chart.png (${png.length} bytes)`);

  // was a call at 20:00 a win?
  const outcome = await ata.result("EURUSD_otc", { time: "20:00", direction: "call" });
  if (outcome.result !== null) {
    console.log("call @ 20:00 ->", outcome.result);
  }

  // candles for a few assets at once; failures stay per-asset
  const results = await ata.scan(["EURUSD_otc", "GBPUSD_otc", "BRLUSD_otc"], {
    hours: 1,
    concurrency: 3,
  });
  for (const [symbol, value] of Object.entries(results)) {
    if (value instanceof Error) console.log(symbol, "failed:", value.name);
    else console.log(symbol, "candles:", value.length);
  }
} finally {
  ata.close();
}
