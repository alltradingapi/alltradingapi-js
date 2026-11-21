/**
 * Candle history with a tiny ASCII sparkline of the closes.
 *
 * Run:
 *   npm install alltradingapi   (or: npm install && npm run build && npm link)
 *   node examples/02_candle_history.mjs
 *
 * Requires ATA_API_KEY.
 */

import { Client } from "alltradingapi";

const BLOCKS = "▁▂▃▄▅▆▇█";

function sparkline(values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1.0;
  return values.map((v) => BLOCKS[Math.min(7, Math.floor(((v - low) / span) * 7))]).join("");
}

const key = process.env.ATA_API_KEY ?? "";
if (!key) {
  console.error("Set ATA_API_KEY first.");
  process.exit(1);
}

const ata = new Client({ apiKey: key });
try {
  const current = await ata.candles("EURUSD_otc", { hours: 1, timeframe: "1m" });
  const history = await ata.history("EURUSD_otc", { hours: 2, timeframe: "1m" });
  console.log("current candles:", current.length);
  console.log("history candles:", history.length);
  if (current.length > 0) {
    console.log("sparkline:", sparkline(current.map((c) => c.close)));
    const last = current[current.length - 1];
    console.log("last close:", last.close, "| doji:", last.isDoji());
  }
} finally {
  ata.close();
}
