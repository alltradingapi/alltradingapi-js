import { describe, expect, it } from "vitest";

import {
  compactJson,
  coerceBoolStr,
  isValidAsset,
  isValidDate,
  isValidTime,
  normalizeAsset,
  redactUrl,
  truncateText,
} from "../src/utils.js";
import { compareVersions, isOutdated, parseVersion } from "../src/update.js";
import { VERSION } from "../src/version.js";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
)) as { version: string };

describe("utils", () => {
  it("redacts query credentials", () => {
    expect(redactUrl("https://x.com/a?asset=EURUSD_otc&key=ap_secret")).toBe(
      "https://x.com/a?asset=EURUSD_otc&key=***",
    );
    expect(redactUrl("https://x.com/a?token=abc123")).toBe("https://x.com/a?token=***");
    expect(redactUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(redactUrl(null)).toBeNull();
  });

  it("redacts bearer tokens", () => {
    expect(redactUrl("GET https://x.com/a")).toBe("GET https://x.com/a");
    expect(redactUrl("Bearer ap_abcdef0123456789")).toBe("Bearer ***");
    expect(redactUrl("Authorization: Bearer ap_deadbeef")).toBe("Authorization: Bearer ***");
  });

  it("validates asset symbols", () => {
    expect(isValidAsset("EURUSD_otc")).toBe(true);
    expect(isValidAsset("AUDCAD")).toBe(true);
    expect(isValidAsset("  GBPUSD_otc ")).toBe(true);
    expect(isValidAsset("EUR")).toBe(true); // 3 chars, within 2..40
    expect(isValidAsset("E")).toBe(false); // too short
    expect(isValidAsset("EUR USD")).toBe(false); // space inside
    expect(isValidAsset("")).toBe(false);
    expect(isValidAsset("X".repeat(41))).toBe(false);
    expect(normalizeAsset(" EURUSD_otc ")).toBe("EURUSD_otc");
  });

  it("validates time and date strings", () => {
    expect(isValidTime("20:00")).toBe(true);
    expect(isValidTime("9:05:31")).toBe(true);
    expect(isValidTime("20:00:00")).toBe(true);
    expect(isValidTime("25:00")).toBe(true); // shape-validated, like the Python SDK
    expect(isValidTime("2000")).toBe(false);
    expect(isValidDate("2026-11-21")).toBe(true);
    expect(isValidDate("2026-1-1")).toBe(false);
  });

  it("coerces booleans the way the server expects", () => {
    expect(coerceBoolStr(true)).toBe("true");
    expect(coerceBoolStr(false)).toBe("false");
    expect(coerceBoolStr("YES")).toBe("yes");
  });

  it("truncates text with a size marker", () => {
    const long = "x".repeat(500);
    const cut = truncateText(long, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("[500 chars]")).toBe(true);
    expect(truncateText("short", 100)).toBe("short");
    expect(compactJson({ a: 1 })).toBe('{"a":1}');
  });
});

describe("version comparison", () => {
  it("compares semantically", () => {
    expect(compareVersions("1.0.1", "1.0.2")).toBe(-1);
    expect(compareVersions("1.0.2", "1.0.1")).toBe(1);
    expect(compareVersions("1.0.2", "1.0.2")).toBe(0);
    expect(compareVersions("2.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("v1.0.2", "1.0.3")).toBe(-1);
  });

  it("sorts pre-releases before the final release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0b2", "1.0.0rc1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0.post1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0.dev1", "1.0.0")).toBe(-1);
  });

  it("fails open on unparsable versions", () => {
    expect(parseVersion("not-a-version!!!")).toBeNull();
    expect(compareVersions("garbage", "1.0.0")).toBe(0);
    expect(parseVersion(null)).toBeNull();
  });

  it("isOutdated only when strictly older", () => {
    expect(isOutdated("1.0.0", "1.0.1")).toBe(true);
    expect(isOutdated("1.0.1", "1.0.0")).toBe(false);
    expect(isOutdated("1.0.0", null)).toBe(false);
    expect(isOutdated("", "1.0.0")).toBe(false);
  });

  it("keeps package.json and VERSION in lockstep", () => {
    expect(pkg.version).toBe(VERSION);
  });
});
