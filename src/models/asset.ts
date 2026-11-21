/** Asset model — one entry of the bare-array response from `/qx_assets`. */

import { isRecordLike } from "../types.js";
import { APIObject } from "./base.js";

function intOrNone(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** A tradable Quotex asset with live open/closed state and payout. */
export class Asset extends APIObject {
  /** Numeric asset id (e.g. `368`). */
  get id(): number {
    return Math.trunc(Number(this._data["asset_id"] ?? 0)) || 0;
  }

  /** Trading symbol, e.g. `EURUSD_otc`. */
  get symbol(): string {
    return String(this._data["asset"] ?? "") || "";
  }

  /** Display name, e.g. `Euro / US Dollar (OTC)`. */
  get name(): string {
    return String(this._data["asset_name"] ?? "") || "";
  }

  /** True when the asset is open for trading right now. */
  get isOpen(): boolean {
    return Boolean(this._data["is_open"]);
  }

  /** Asset class: currency, cryptocurrency, commodity, ... */
  get type(): string {
    return String(this._data["type"] ?? "") || "";
  }

  /** Base payout percentage (e.g. `77`). */
  get payout(): number {
    return Math.trunc(Number(this._data["payout"] ?? 0)) || 0;
  }

  /** 24h change, when the market reports it. */
  get change24h(): number | null {
    const value = this._data["change_24h"];
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Payout for 1-minute expiry. */
  get profit1m(): number | null {
    const profit = this._data["profit"];
    if (isRecordLike(profit)) return intOrNone(profit["1M"]);
    return null;
  }

  /** Payout for 5-minute expiry. */
  get profit5m(): number | null {
    const profit = this._data["profit"];
    if (isRecordLike(profit)) return intOrNone(profit["5M"]);
    return null;
  }

  /** True when the symbol carries the `_otc` suffix. */
  get isOtc(): boolean {
    return this.symbol.toLowerCase().endsWith("_otc");
  }

  override toString(): string {
    return this.symbol;
  }
}
