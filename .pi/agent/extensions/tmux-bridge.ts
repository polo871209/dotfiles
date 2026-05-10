// tmux-bridge — exposes a Unix socket so other tmux panes can push
// user messages into this running pi session.
//
// Socket path: $TMPDIR/pi-tmux-<sanitized-session-id>/bridge.sock
// Companion CLI: dotfiles/tmux/pi-send (writes one JSON line per message).
//
// Wire format: one JSON object per line, e.g.
//   {"text": "hello"}
//   {"text": "...", "mode": "steer" | "followUp"}   // mode used while streaming
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

function getTmuxSessionId(): string | null {
  if (!process.env.TMUX) return null;
  try {
    const id = execSync("tmux display-message -p '#{session_id}'", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return id || null;
  } catch {
    return null;
  }
}

function socketDirFor(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `pi-tmux-${safe}`);
}

function socketPathFor(sessionId: string): string {
  return path.join(socketDirFor(sessionId), "bridge.sock");
}

export default function (pi: ExtensionAPI) {
  const sessionId = getTmuxSessionId();
  if (!sessionId) return; // not in tmux — nothing to do
  const sockDir = socketDirFor(sessionId);
  const sockPath = socketPathFor(sessionId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: { text?: string; mode?: "steer" | "followUp" };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      currentCtx?.ui?.notify?.(
        "tmux-bridge: dropped malformed JSON line",
        "warning",
      );
      return;
    }
    const text = payload.text;
    if (!text || typeof text !== "string") return;

    const idle = currentCtx?.isIdle?.() ?? true;
    // When idle, sendUserMessage triggers a turn immediately.
    // When streaming, deliverAs is required.
    const opts = idle ? undefined : { deliverAs: payload.mode ?? "steer" };

    try {
      pi.sendUserMessage(text, opts as never);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      currentCtx?.ui?.notify?.(`tmux-bridge: ${msg}`, "error");
    }
  };

  const probeExistingListener = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (!fs.existsSync(sockPath)) return resolve(false);
      const probe = net.createConnection(sockPath);
      let decided = false;
      const done = (alive: boolean) => {
        if (decided) return;
        decided = true;
        probe.destroy();
        resolve(alive);
      };
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
      setTimeout(() => done(false), 200);
    });

  const start = async (ctx: ExtensionContext) => {
    currentCtx = ctx;
    if (server) return;
    if (await probeExistingListener()) {
      ctx.ui?.notify?.(
        `tmux-bridge: another pi is already listening on ${sockPath}; ` +
          "this instance will not receive sends from pi-send / neovim.",
        "warning",
      );
      return;
    }
    try {
      fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(sockDir, 0o700);
      fs.unlinkSync(sockPath); // stale file from a crashed pi
    } catch {
      /* not present */
    }
    server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
          idx = buf.indexOf("\n");
        }
      });
      socket.on("error", () => {
        /* ignore peer disconnects */
      });
    });
    server.on("error", (err) => {
      ctx.ui?.notify?.(`tmux-bridge: ${err.message}`, "error");
    });
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* best effort */
      }
    });
  };

  const stop = () => {
    if (!server) return; // we never owned the socket; don't unlink another pi's file
    server.close();
    server = undefined;
    try {
      fs.unlinkSync(sockPath);
      fs.rmdirSync(sockDir);
    } catch {
      /* ignore */
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    start(ctx);
  });
  pi.on("session_shutdown", async () => {
    stop();
  });
}
