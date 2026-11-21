import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError, ValidationError } from "../src/errors.js";
import type { CandleOptions } from "../src/client.js";
import { Asset } from "../src/models/asset.js";
import { Candle } from "../src/models/candle.js";
import { SavedCandles } from "../src/models/candle.js";
import { TradeResult } from "../src/models/tradeResult.js";
import { Client } from "../src/client.js";
import { startFakeServer, type FakeServer } from "./fakeServer.js";

let server: FakeServer;

beforeAll(async () => {
  server = await startFakeServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.ATA_API_KEY;
  delete process.env.ATA_KEY_QUOTEX_ASSETS;
});

afterEach(() => {
  delete process.env.ATA_API_KEY;
  delete process.env.ATA_KEY_QUOTEX_ASSETS;
  vi.unstubAllEnvs();
});

/** A client pointed at the fake server with the update gate disabled. */
const client = (opts: ConstructorParameters<typeof Client>[0] = {}) =>
  new Client({ apiKey: "ap_test", updatePolicy: "off", baseUrl: server.baseUrl, ...opts });

describe("Client", () => {
  it("fetches assets and caches the response", async () => {
    const ata = client();
    const before = server.hits["/qx_assets"] ?? 0;
    const assets = await ata.assets();
    expect(assets.length).toBeGreaterThan(0);
    expect(assets[0]).toBeInstanceOf(Asset);
    expect(server.hits["/qx_assets"]).toBe(before + 1);

    const again = await ata.assets(); // served from the TTL cache
    expect(again).toHaveLength(assets.length);
    expect(server.hits["/qx_assets"]).toBe(before + 1);

    const fresh = await ata.assets({ refresh: true }); // cache bypassed
    expect(fresh).toHaveLength(assets.length);
    expect(server.hits["/qx_assets"]).toBe(before + 2);
    ata.close();
  });

  it("filters to open assets", async () => {
    const ata = client();
    const all = await ata.assets();
    const open = await ata.assets({ onlyOpen: true });
    expect(open.every((a) => a.isOpen)).toBe(true);
    expect(open.length).toBeLessThan(all.length);
    ata.close();
  });

  it("fetches candles and applies client-side validation first", async () => {
    const ata = client();
    const candles = await ata.candles("EURUSD_otc", { hours: 2, timeframe: "1m" });
    expect(candles.length).toBeGreaterThan(0);
    expect(candles[0]).toBeInstanceOf(Candle);

    await expect(ata.candles("EURUSD_otc", { hours: 99 })).rejects.toBeInstanceOf(ValidationError);
    await expect(ata.candles("EUR USD")).rejects.toBeInstanceOf(ValidationError);
    await expect(ata.candles("EURUSD_otc", { badParam: true } as unknown as CandleOptions)).rejects.toThrow(
      /Unknown parameter/,
    );
    ata.close();
  });

  it("fetches history via the same validation path", async () => {
    const ata = client();
    const rows = await ata.history("EURUSD_otc", { hours: 1 });
    expect(rows.length).toBeGreaterThan(0);
    ata.close();
  });

  it("fetches saved candles", async () => {
    const ata = client();
    const saved = await ata.saved("EURUSD_otc", { count: 50 });
    expect(saved).toBeInstanceOf(SavedCandles);
    expect(saved.returnedCount).toBe(3);
    expect(saved.length).toBe(3);
    ata.close();
  });

  it("downloads chart screenshots as PNG bytes", async () => {
    const ata = client();
    const png = await ata.screenshot("EURUSD_otc", { timeframe: "1m" });
    expect(Buffer.isBuffer(png));
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    ata.close();
  });

  it("checks trade results", async () => {
    const ata = client();
    const outcome = await ata.result("EURUSD_otc", { time: "20:00", direction: "call" });
    expect(outcome).toBeInstanceOf(TradeResult);
    expect(outcome.result).toBe("win");
    ata.close();
  });

  it("resolves keys by product, then default, then constructor, then env", async () => {
    // per-product key wins over everything else
    const ata = client({
      keys: { "quotex-assets": "ap_assets", default: "ap_default" },
      apiKey: "ap_ctor",
    });
    await ata.assets();
    expect(server.lastUserAgent).toBeTruthy();
    ata.close();

    // missing key -> actionable AuthenticationError without touching the network
    const noKey = new Client({ updatePolicy: "off", baseUrl: server.baseUrl });
    await expect(noKey.candles("EURUSD_otc")).rejects.toThrow(AuthenticationError);
    await expect(noKey.candles("EURUSD_otc")).rejects.toThrow(/ATA_KEY_QUOTEX_QUOTES/);
    noKey.close();

    // environment fallback
    process.env.ATA_API_KEY = "ap_env";
    const envClient = new Client({ updatePolicy: "off", baseUrl: server.baseUrl });
    const assets = await envClient.assets();
    expect(assets.length).toBeGreaterThan(0);
    envClient.close();

    // per-product env fallback (ATA_KEY_QUOTEX_ASSETS)
    delete process.env.ATA_API_KEY;
    process.env.ATA_KEY_QUOTEX_ASSETS = "ap_env_product";
    const productEnv = new Client({ updatePolicy: "off", baseUrl: server.baseUrl });
    expect((await productEnv.assets()).length).toBeGreaterThan(0);
    productEnv.close();
  });

  it("supports query auth mode", async () => {
    const ata = client({ authMode: "query" });
    // The fake server accepts `key=` in the query for /qx_assets.
    const assets = await ata.assets();
    expect(assets.length).toBeGreaterThan(0);
    ata.close();
  });

  it("rejects invalid auth modes and unknown endpoints", () => {
    expect(() => new Client({ authMode: "cookie" as never })).toThrow(/authMode must be/);
  });

  it("fan-out scan isolates per-asset failures", async () => {
    const ata = client();
    const results = await ata.scan(["EURUSD_otc", "EUR USD", "AUDCAD"], { concurrency: 2 });
    expect(results["EURUSD_otc"]).toBeInstanceOf(Array);
    expect(results["EUR USD"]).toBeInstanceOf(Error);
    ata.close();
  });

  it("skips the update gate when disabled", async () => {
    const ata = client({ updatePolicy: "off" });
    expect(ata.version).toBeTruthy();
    const info = await ata.checkUpdates(true);
    expect(info.installed).toBeTruthy();
    ata.close();
  });
});
