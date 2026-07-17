// Loopback HTTP bridge. Kernels call back into host tools via POST /v1/tool.
//
// One shared http.Server instance across all kernel sessions; each session
// registers a handler keyed by its session id. Pi runs under Node, so we use
// node:http rather than Bun.serve.

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { BridgeRequest, BridgeResponse } from "./types";

export type BridgeHandler = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

interface BridgeServer {
  url: string;
  token: string;
  stop: () => void;
}

const registrations = new Map<string, BridgeHandler>();
const currentSignals = new Map<string, AbortSignal>();
let server: BridgeServer | null = null;

export function setBridgeSignal(
  session: string,
  signal: AbortSignal | undefined,
): void {
  if (signal) currentSignals.set(session, signal);
  else currentSignals.delete(session);
}

function send(res: http.ServerResponse, status: number, body: BridgeResponse) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function ensureServer(): Promise<BridgeServer> {
  if (server) return server;
  const token = randomUUID();
  const s = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/tool") {
      res.writeHead(404).end("Not Found");
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let body: BridgeRequest;
    try {
      const text = await readBody(req);
      body = JSON.parse(text) as BridgeRequest;
    } catch {
      send(res, 400, { ok: false, error: "invalid JSON" });
      return;
    }
    const handler = registrations.get(body.session);
    if (!handler) {
      send(res, 200, {
        ok: false,
        error: `no active session: ${body.session}`,
      });
      return;
    }
    // Best-effort abort: a session may pin its current signal via the
    // registration map (set by index.ts at execute() start).
    const signal = currentSignals.get(body.session);
    try {
      const value = await handler(body.name, body.args ?? {}, signal);
      send(res, 200, { ok: true, value });
    } catch (err) {
      send(res, 200, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    s.once("listening", resolve);
    s.once("error", reject);
    s.listen(0, "127.0.0.1");
  });
  // unref() so tests / standalone hosts can exit; pi keeps its own refs.
  s.unref();
  const addr = s.address() as AddressInfo | null;
  if (!addr) throw new Error("bridge server failed to bind");
  server = {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    stop: () => s.close(),
  };
  return server;
}

export interface BridgeRegistration {
  url: string;
  token: string;
  session: string;
  unregister: () => void;
}

export async function registerBridgeSession(
  handler: BridgeHandler,
): Promise<BridgeRegistration> {
  const srv = await ensureServer();
  const session = randomUUID();
  registrations.set(session, handler);
  return {
    url: srv.url,
    token: srv.token,
    session,
    unregister: () => {
      registrations.delete(session);
      currentSignals.delete(session);
      if (registrations.size === 0 && server) {
        server.stop();
        server = null;
      }
    },
  };
}
