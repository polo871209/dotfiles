// Loopback HTTP bridge for Python calls into host tools.

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

function send(
  res: http.ServerResponse,
  status: number,
  body: BridgeResponse,
): void {
  if (res.headersSent) return;
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

function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.session === "string" &&
    typeof body.name === "string" &&
    !!body.args &&
    typeof body.args === "object" &&
    !Array.isArray(body.args)
  );
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/v1/tool") {
    res.writeHead(404).end("Not Found");
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { ok: false, error: "invalid JSON" });
    return;
  }
  if (!isBridgeRequest(body)) {
    send(res, 400, {
      ok: false,
      error: "body must contain string session/name and object args",
    });
    return;
  }

  const handler = registrations.get(body.session);
  if (!handler) {
    send(res, 200, { ok: false, error: `no active session: ${body.session}` });
    return;
  }
  const signal = currentSignals.get(body.session);
  try {
    const value = await handler(body.name, body.args, signal);
    send(res, 200, { ok: true, value });
  } catch (err) {
    send(res, 200, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function ensureServer(): Promise<BridgeServer> {
  if (server) return server;
  const token = randomUUID();
  const s = http.createServer((req, res) => {
    void handleRequest(req, res, token).catch(() => {
      try {
        if (res.headersSent) res.destroy();
        else send(res, 500, { ok: false, error: "bridge request failed" });
      } catch {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    s.once("listening", resolve);
    s.once("error", reject);
    s.listen(0, "127.0.0.1");
  });
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
  let active = true;
  return {
    url: srv.url,
    token: srv.token,
    session,
    unregister: () => {
      if (!active) return;
      active = false;
      registrations.delete(session);
      currentSignals.delete(session);
      if (registrations.size === 0 && server) {
        server.stop();
        server = null;
      }
    },
  };
}
