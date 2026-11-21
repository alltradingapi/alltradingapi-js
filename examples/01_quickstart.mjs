/**
 * Fetch the latest candles for an asset and print a small table.
 *
 * Run:
 *   npm install alltradingapi   (or: npm install && npm run build && npm link)
 *   node examples/01_quickstart.mjs
 *
 * Requires ATA_API_KEY.
 */

import { Client } from "alltradingapi";

const key = process.env.ATA_API_KEY ?? "";
if (!key) {
  console.error("Set ATA_API_KEY first.");
  process.exit(1);
}

const ata = new Client({ apiKey: key });
try {
  const assets = await ata.assets({ onlyOpen: true });
  console.log("Open assets:", assets.length);
  if (assets.length === 0) {
    console.log("Nothing is open right now.");
    process.exit(0);
  }

  const symbol = assets[0].symbol;
  const candles = await ata.candles(symbol, { hours: 1, timeframe: "1m" });
  console.log(`\n${symbol} - last 5 candles (1m):`);
  console.log(
    "time".padEnd(20),
    ...["open", "high", "low", "close"].map((h) => h.padStart(9)),
    "dir",
  );
  for (const c of candles.slice(-5)) {
    const time = (c.timeRead || "").slice(0, 19) || String(c.time);
    console.log(
      time.padEnd(20),
      ...[c.open, c.high, c.low, c.close].map((v) => v.toFixed(5).padStart(9)),
      c.direction,
    );
  }

  const saved = await ata.saved(symbol, { count: 50 });
  console.log(`\nSaved candles returned: ${saved.returnedCount}`);
} finally {
  ata.close();
}
