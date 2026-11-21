/** Small shared type aliases used across the SDK. */

/** A plain JSON object record. */
export type RecordLike = Record<string, unknown>;

/** Anything JSON-serialisable. */
export type JSONLike =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

export function isRecordLike(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ParamValue = string | number | boolean | null | undefined;

/** Ordered query-parameter pair, ready for urlencoding. */
export type QueryParam = [string, string];
