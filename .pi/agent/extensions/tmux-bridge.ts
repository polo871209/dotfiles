// tmux-bridge — exposes a Unix socket so nvim (or anything else in the same
// tmux session) can push structured messages into this running pi instance.
//
// Socket is keyed by this pi's own tmux pane, not the session: several pi
// panes can be running in one session, each gets its own socket, and the
// consumer (nvim/lua/pi.lua) discovers all of them and lets you pick which
// agent to send to. Subagent panes (PI_IS_SUBAGENT) are excluded — they
// never open a bridge socket.
//
// Socket path: <tmpdir>/pi-tmux-pane-<sanitized-pane-id>.sock
//
// Wire format: one JSON object per line, e.g.
//   {"text": "hello"}
//   {"prompt": "...", "file": {"path": ..., "sline": ..., "eline": ..., "ft": ..., "content": ...}}
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

function socketPathForPane(paneId: string): string {
  const safe = paneId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `pi-tmux-pane-${safe}.sock`);
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT) return; // subagents don't get their own bridge
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) return; // not in tmux — nothing to do
  const sockPath = socketPathForPane(paneId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  // Files pushed from nvim arrive as a custom message so the LLM gets full
  // content (convertToLlm maps custom -> user) while the TUI shows one compact
  // line. The file body lives in the user's editor, so we never expand it here.
  pi.registerMessageRenderer("nvim-file", (message, _opts, theme) => {
    const d = message.details as
      { path: string; sline: number; eline: number } | undefined;
    const label = d ? `${d.path} (L${d.sline}-${d.eline})` : "file context";
    const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", label), 0, 0));
    return box;
  });

  type FilePayload = {
    path: string;
    sline: number;
    eline: number;
    ft?: string;
    content: string;
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: {
      text?: string;
      prompt?: string;
      file?: FilePayload;
      mode?: "steer" | "followUp";
    };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      currentCtx?.ui.notify(
        "tmux-bridge: dropped malformed JSON line",
        "warning",
      );
      return;
    }

    const VALID_MODES = new Set(["steer", "followUp"]);
    const mode =
      payload.mode && VALID_MODES.has(payload.mode) ? payload.mode : "steer";
    const idle = currentCtx?.isIdle() ?? true;
    // When idle, sendUserMessage triggers a turn immediately.
    // When streaming, deliverAs is required.
    const opts = idle ? undefined : { deliverAs: mode };

    try {
      const f = payload.file;
      if (f && typeof f.content === "string" && typeof f.path === "string") {
        // Inject the file as a custom message (full content -> LLM, compact in
        // TUI), then the question as the user message that triggers the turn.
        // Prefix every line with a real file line-number gutter so the model
        // cites the editor's actual lines instead of recounting the snippet
        // (which drifts on files with headers/comments).
        const srcLines = f.content.split("\n");
        const width = String(srcLines.length).length;
        const numbered = srcLines
          .map((l, i) => `${String(i + 1).padStart(width)} | ${l}`)
          .join("\n");
        const block =
          `${f.path} — ENTIRE file below; do NOT read it again, you already have all of it. ` +
          `Each line is prefixed with a display-only line-number gutter ("N | code"). ` +
          `Use those numbers to cite lines exactly — never recount or renumber. ` +
          `The gutter is NOT part of the file: strip the "N | " prefix when quoting code or matching text for an edit. ` +
          `The user is asking about lines ${f.sline}-${f.eline}.\n` +
          `\`\`\`${f.ft ?? ""}\n${numbered}\n\`\`\``;
        // nextTurn queues the file so prompt() injects it right after the user
        // message (agent-session pushes pending nextTurn msgs below the prompt),
        // making it render under the input instead of above it.
        pi.sendMessage(
          {
            customType: "nvim-file",
            content: block,
            display: true,
            details: {
              path: f.path,
              sline: f.sline,
              eline: f.eline,
            },
          },
          { deliverAs: "nextTurn" },
        );
        pi.sendUserMessage(payload.prompt ?? "", opts);
        return;
      }
      const text = payload.text;
      if (!text || typeof text !== "string") return;
      pi.sendUserMessage(text, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      currentCtx?.ui.notify(`tmux-bridge: ${msg}`, "error");
    }
  };

  const start = (ctx: ExtensionContext) => {
    if (server) {
      currentCtx = ctx;
      return; // already listening (e.g. /new re-firing session_start)
    }
    currentCtx = ctx;
    try {
      fs.unlinkSync(sockPath); // stale file from a crashed pi in this pane
    } catch {
      /* not present */
    }
    const MAX_BUF = 256 * 1024; // hard cap per connection to avoid DoS
    server = net.createServer((socket: net.Socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_BUF) {
          currentCtx?.ui.notify(
            "tmux-bridge: oversize line dropped",
            "warning",
          );
          buf = "";
          socket.destroy();
          return;
        }
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
    server.on("error", (err: Error) => {
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
    if (!server) return;
    server.close();
    server = undefined;
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  };

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    start(ctx);
  });
  pi.on("session_shutdown", async () => {
    stop();
  });
}
