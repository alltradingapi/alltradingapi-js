import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UpdateCheckError,
  UpdateRequiredError,
} from "../src/errors.js";
import {
  UpdateInfo,
  checkForUpdate,
  coerceUpdatePolicy,
  ensureUsable,
  parseVersion,
  readCache,
  resetGateState,
  resolvePolicy,
  writeCache,
} from "../src/update.js";
import { VERSION } from "../src/version.js";

let tmpDir: string;

beforeEach(() => {
  resetGateState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ata-update-"));
});

afterEach(() => {
  resetGateState();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("policy", () => {
  it("coerces values tolerantly", () => {
    expect(coerceUpdatePolicy("strict")).toBe("strict");
    expect(coerceUpdatePolicy("OFF")).toBe("off");
    expect(coerceUpdatePolicy("banana")).toBeNull();
    expect(coerceUpdatePolicy("banana", "warn")).toBe("warn");
    expect(coerceUpdatePolicy(undefined, "ask")).toBe("ask");
  });

  it("resolves from arg, then env, then strict default", () => {
    expect(resolvePolicy("warn")).toBe("warn");
    vi.stubEnv("ATA_UPDATE_POLICY", "off");
    expect(resolvePolicy()).toBe("off");
    vi.stubEnv("ATA_UPDATE_POLICY", "");
    expect(resolvePolicy()).toBe("strict");
  });
});

describe("checkForUpdate", () => {
  it("reports up-to-date versions as known and not outdated", async () => {
    const fetcher = async () => VERSION;
    const info = await checkForUpdate(true, VERSION, { cacheDir: tmpDir, fetcher });
    expect(info.known).toBe(true);
    expect(info.isOutdated).toBe(false);
    expect(info.latest).toBe(VERSION);
    expect(info.source).toBe("npm");
  });

  it("flags outdated versions", async () => {
    const fetcher = async () => "999.0.0";
    const info = await checkForUpdate(true, VERSION, { cacheDir: tmpDir, fetcher });
    expect(info.isOutdated).toBe(true);
    expect(info.latest).toBe("999.0.0");
  });

  it("fails open when the registry is unreachable", async () => {
    const fetcher = async () => null;
    const info = await checkForUpdate(true, VERSION, { cacheDir: tmpDir, fetcher });
    expect(info.known).toBe(false);
    expect(info.latest).toBeNull();
    expect(info.isOutdated).toBe(false);
    expect(info.source).toBe("npm");
  });

  it("caches results on disk and reuses them until the TTL expires", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return "1.2.3";
    };
    const now = 1_000_000;
    const first = await checkForUpdate(false, VERSION, { cacheDir: tmpDir, fetcher, now });
    expect(calls).toBe(1);
    expect(first.latest).toBe("1.2.3");
    expect(readCache(tmpDir)).toMatchObject({ latest: "1.2.3", source: "npm" });

    const second = await checkForUpdate(false, VERSION, { cacheDir: tmpDir, fetcher, now: now + 60 });
    expect(calls).toBe(1); // served from cache
    expect(second.latest).toBe("1.2.3");
    expect(second.source).toBe("npm");

    const third = await checkForUpdate(false, VERSION, {
      cacheDir: tmpDir,
      fetcher,
      now: now + 99999,
    });
    expect(calls).toBe(2); // TTL expired -> refetch
    expect(third.checkedAt).toBe(now + 99999);
  });

  it("honours force to bypass the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return VERSION;
    };
    await checkForUpdate(false, VERSION, { cacheDir: tmpDir, fetcher });
    await checkForUpdate(true, VERSION, { cacheDir: tmpDir, fetcher });
    expect(calls).toBe(2);
  });

  it("falls back to the bundled version when installed is null", async () => {
    const info = await checkForUpdate(true, null, {
      cacheDir: tmpDir,
      fetcher: async () => VERSION,
    });
    expect(info.installed).toBe(VERSION);
    expect(info.known).toBe(true);
  });
});

describe("ensureUsable", () => {
  const upToDate = async (): Promise<string | null> => VERSION;
  const newer = async (): Promise<string | null> => "999.0.0";

  it("passes when the SDK is current", async () => {
    const info = await ensureUsable(VERSION, { policy: "strict", cacheDir: tmpDir, fetcher: upToDate });
    expect(info).toBeInstanceOf(UpdateInfo);
    expect(info?.isOutdated).toBe(false);
  });

  it("blocks in strict mode when outdated (non-interactive)", async () => {
    await expect(
      ensureUsable(VERSION, {
        policy: "strict",
        interactive: false,
        cacheDir: tmpDir,
        fetcher: newer,
      }),
    ).rejects.toThrow(UpdateRequiredError);
    // The blocked state sticks for the rest of the process.
    await expect(
      ensureUsable(VERSION, { policy: "strict", cacheDir: tmpDir, fetcher: upToDate }),
    ).rejects.toThrow(UpdateRequiredError);
  });

  it("warns and continues in warn mode", async () => {
    const lines: string[] = [];
    const info = await ensureUsable(VERSION, {
      policy: "warn",
      cacheDir: tmpDir,
      fetcher: newer,
      printer: (t) => lines.push(t),
    });
    expect(info?.isOutdated).toBe(true);
    expect(lines.join("\n")).toContain("a newer SDK is available");
  });

  it("maps allowOutdated to warn", async () => {
    const info = await ensureUsable(VERSION, {
      policy: "strict",
      allowOutdated: true,
      cacheDir: tmpDir,
      fetcher: newer,
    });
    expect(info?.isOutdated).toBe(true);
  });

  it("continues on decline in ask mode", async () => {
    const info = await ensureUsable(VERSION, {
      policy: "ask",
      interactive: true,
      cacheDir: tmpDir,
      fetcher: newer,
      inputFn: async () => "n",
    });
    expect(info?.isOutdated).toBe(true);
  });

  it("blocks after a declined update in strict interactive mode", async () => {
    await expect(
      ensureUsable(VERSION, {
        policy: "strict",
        interactive: true,
        cacheDir: tmpDir,
        fetcher: newer,
        inputFn: async () => "n",
      }),
    ).rejects.toThrow(/refuses to operate when outdated/);
  });

  it("reports restart-required after a successful in-process update", async () => {
    await expect(
      ensureUsable(VERSION, {
        policy: "strict",
        interactive: true,
        cacheDir: tmpDir,
        fetcher: newer,
        inputFn: async () => "y",
        installer: async () => ({ code: 0, output: "added 1 package" }),
      }),
    ).rejects.toThrow(/Restart your program/);
  });

  it("falls back to manual update instructions when npm fails", async () => {
    const lines: string[] = [];
    await expect(
      ensureUsable(VERSION, {
        policy: "strict",
        interactive: true,
        cacheDir: tmpDir,
        fetcher: newer,
        inputFn: async () => "y",
        installer: async () => ({ code: 1, output: "npm ERR! something" }),
        printer: (t) => lines.push(t),
      }),
    ).rejects.toThrow(/refuses to operate when outdated/);
    expect(lines.join("\n")).toContain("Automatic update failed");
    expect(lines.join("\n")).toContain("npm install alltradingapi@latest");
  });

  it("returns null when the policy is off", async () => {
    const info = await ensureUsable(VERSION, { policy: "off", fetcher: newer, cacheDir: tmpDir });
    expect(info).toBeNull();
  });

  it("returns null when ATA_SKIP_UPDATE is set", async () => {
    vi.stubEnv("ATA_SKIP_UPDATE", "1");
    const info = await ensureUsable(VERSION, { policy: "strict", fetcher: newer, cacheDir: tmpDir });
    expect(info).toBeNull();
  });

  it("fails open when the registry check is unknown", async () => {
    const info = await ensureUsable(VERSION, {
      policy: "strict",
      interactive: false,
      cacheDir: tmpDir,
      fetcher: async () => null,
    });
    expect(info?.known).toBe(false);
  });
});

describe("parseVersion", () => {
  it("parses plain and padded releases", () => {
    expect(parseVersion("1.2.3")).not.toBeNull();
    expect(parseVersion("1.2")).not.toBeNull();
    expect(parseVersion("v2.0.0")).not.toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});
