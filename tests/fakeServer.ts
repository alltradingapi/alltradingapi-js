/**
 * A real HTTP server for end-to-end transport tests (localhost only).
 *
 * Canned routes mirror the live API contract, including error envelopes,
 * Retry-After on 429, gzip responses, and a PNG screenshot endpoint.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

function load(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

function loadJson(name: string): unknown {
  return JSON.parse(load(name).toString("utf-8"));
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extra: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function sendGzipJson(res: ServerResponse, payload: unknown): void {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

export interface FakeServer {
  baseUrl: string;
  close(): Promise<void>;
  /** Request counts per path (query string stripped). */
  hits: Record<string, number>;
  lastUserAgent: string | null;
}

export async function startFakeServer(): Promise<FakeServer> {
  const state: FakeServer = {
    baseUrl: "",
    close: async () => {},
    hits: {},
    lastUserAgent: null,
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const parsedPath = (req.url ?? "/").split("?")[0] ?? "/";
    state.hits[parsedPath] = (state.hits[parsedPath] ?? 0) + 1;
    state.lastUserAgent = req.headers["user-agent"] ?? null;

    const readBody = (): Promise<Buffer> => {
      return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
    };

    if (req.method === "POST") {
      void readBody().then(() => {
        if (parsedPath === "/qx_429") {
          sendJson(res, 429, { error: "Rate limit reached." }, { "Retry-After": "1" });
        } else if (parsedPath === "/qx_500") {
          sendJson(res, 500, { error: "boom" });
        } else {
          sendJson(res, 404, { error: "not found" });
        }
      });
      return;
    }

    if (parsedPath === "/qx_assets") {
      const auth = req.headers["authorization"] ?? "";
      if (!(auth.startsWith("Bearer ") || (req.url ?? "").includes("key="))) {
        sendJson(res, 401, { error: "A valid API key is required." });
      } else {
        sendJson(res, 200, loadJson("assets.json"));
      }
    } else if (parsedPath === "/qx_gzip") {
      sendGzipJson(res, loadJson("candles.json"));
    } else if (parsedPath === "/qx_429") {
      sendJson(res, 429, { error: "Rate limit reached." }, { "Retry-After": "1" });
    } else if (parsedPath === "/qx_429_fast") {
      sendJson(res, 429, { error: "Rate limit reached." }, { "Retry-After": "0" });
    } else if (parsedPath === "/qx_500") {
      sendJson(res, 500, { error: "boom" });
    } else if (parsedPath === "/qx_502") {
      sendJson(res, 502, { error: "Upstream feed failure / insufficient candles." });
    } else if (parsedPath === "/qx_400") {
      sendJson(res, 400, { error: "That parameter is not available on this API." });
    } else if (parsedPath === "/qx_401") {
      sendJson(res, 401, { error: "A valid API key is required." });
    } else if (parsedPath === "/qx_403") {
      sendJson(res, 403, { error: "This key does not include that API." });
    } else if (parsedPath === "/qx_ss_pro_v2") {
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x30)]);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(png.length) });
      res.end(png);
    } else if (parsedPath === "/qx_truncated") {
      const body = Buffer.from('{"error": "truncat', "utf-8");
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      res.end(body);
    } else if (parsedPath === "/qx_candles") {
      sendJson(res, 200, loadJson("candles.json"));
    } else if (parsedPath === "/qx_history") {
      sendJson(res, 200, loadJson("candles.json"));
    } else if (parsedPath === "/qx_saved") {
      sendJson(res, 200, loadJson("saved.json"));
    } else if (parsedPath === "/qx_result") {
      sendJson(res, 200, loadJson("result.json"));
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return state;
}
