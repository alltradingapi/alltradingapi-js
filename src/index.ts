/**
 * alltradingapi — JavaScript/TypeScript SDK for the All Trading API.
 *
 * Independent, unofficial API provider. Not affiliated with, endorsed by, or
 * connected to Quotex. This SDK provides market data only; it cannot place
 * trades and is not financial advice.
 *
 * Quick start:
 *
 * ```js
 * import { Client } from "alltradingapi";
 *
 * const ata = new Client({ apiKey: "ap_..." });
 * const candles = await ata.candles("EURUSD_otc");
 * console.log(candles[candles.length - 1].close);
 * ata.close();
 * ```
 */

export { VERSION as __version } from "./version.js";
export { AsyncClient, Client } from "./client.js";
export type {
  AssetsOptions,
  CandleOptions,
  ClientOptions,
  ResultOptions,
  ScreenshotOptions,
  SavedOptions,
  ScanOptions,
} from "./client.js";
export {
  ALLError,
  AuthenticationError,
  ConfigurationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
  TransportError,
  UpdateCheckError,
  UpdateRequiredError,
  UpstreamError,
  ValidationError,
  updateHint,
} from "./errors.js";
export { setLogLevel, logger } from "./logging.js";
export type { LogLevel, Logger } from "./logging.js";
export {
  APIObject,
  Asset,
  Candle,
  SavedCandles,
  TradeOutcome,
  TradeResult,
  coerceOutcome,
  outcomeLost,
  outcomePending,
  outcomeWon,
} from "./models/index.js";
export { allowedParams, validateParams } from "./params.js";
export { Response, Transport } from "./transport.js";
export {
  UPDATE_POLICIES,
  UpdateInfo,
  checkForUpdate,
  coerceUpdatePolicy,
  compareVersions,
  ensureUsable,
  fetchLatest,
  installUpdate,
  isOutdated,
  parseVersion,
  resolvePolicy,
  resetGateState,
  upgradeCommand,
} from "./update.js";
export type { UpdatePolicy } from "./update.js";
export { isValidAsset as validateAsset, redactUrl } from "./utils.js";
export { TTLCache } from "./cache.js";
