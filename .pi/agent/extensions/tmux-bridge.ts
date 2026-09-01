// tmux-bridge — exposes a Unix socket so nvim (or anything else in the same
// tmux session) can push structured messages into this running pi instance.
//
// Socket is keyed by this pi's own tmux pane, not the session: several pi
// panes can be running in one session, each gets its own socket, and the
// consumer (nvim/lua/pi.lua) discovers all of them and lets you pick which
// agent to send to. Subagent panes (PI_IS_SUBAGENT) are excluded — they
// never open a bridge socket.
//
// Socket path: <tmpdir>/pi-tmux-pane-<sanitized-pane-id>-<pid>.sock. The pid
// keeps a crashed pi's leftover socket file from shadowing the live one, and
// lets the client find bridges by globbing rather than by guessing which pane
// runs pi (pi reports as "node", and its pane title is decoration that moves
// with session state).
//
// Wire format: one JSON object per line, e.g.
//   {"text": "hello"}                     -- send immediately, triggers a turn
//   {"paste": "some reference text"}      -- drop into pi's own input editor, no turn
//   {"file": {"path": ..., "sline": ..., "eline": ..., "ft": ..., "content": ...}}
//                                          -- line-numbered snapshot: steers a running
//                                             turn, else rides the next user prompt
// Optional "mode": "steer" | "followUp" | "nextTurn" overrides that choice.
//
// Each line is answered with one JSON line, {"ok":true,"delivered":<where>} or
// {"ok":false,"error":...}, so the client can report what actually happened
// instead of assuming a successful write means the message landed.
//
// "paste" lands in the real pi editor (ctx.ui.pasteToEditor) rather than being
// sent as a message directly, so the user finishes composing there with full
// slash-command support and pi's own completion — neither exists in an
// nvim-side input prompt. "file" instead rides along as a queued custom
// message so the editor (and the transcript) stay free of snapshot bulk.
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
  return path.join(os.tmpdir(), `pi-tmux-pane-${safe}-${process.pid}.sock`);
}

// Clients send absolute paths because their cwd need not match pi's; show the
// short form when the file is under this session's cwd.
function displayPath(filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(process.cwd(), filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}

type FilePayload = {
  path: string;
  sline: number;
  eline: number;
  ft?: string;
  content: string;
};

// Keep complete snapshots below 80 KiB; large snapshots focus the injected
// context on the selection while preserving source line numbers for edits/cites.
const FULL_SNAPSHOT_MAX_BYTES = 80 * 1024;
const SURROUNDING_LINES = 40;
const SNAPSHOT_MESSAGE_TYPE = "tmux-bridge-file";

type SnapshotDetails = { path: string; sline: number; eline: number };

function snapshotLabel(d: SnapshotDetails): string {
  return `${displayPath(d.path)} (L${d.sline}-${d.eline})`;
}

export function formatFileSnapshot(f: FilePayload): string {
  const srcLines = f.content.split(/\r?\n/);
  const total = srcLines.length;
  const selectedStart = Math.min(Math.max(Math.floor(f.sline), 1), total);
  const selectedEnd = Math.min(
    Math.max(Math.floor(f.eline), selectedStart),
    total,
  );
  const complete =
    Buffer.byteLength(f.content, "utf8") <= FULL_SNAPSHOT_MAX_BYTES;
  const from = complete ? 1 : Math.max(1, selectedStart - SURROUNDING_LINES);
  const to = complete
    ? total
    : Math.min(total, selectedEnd + SURROUNDING_LINES);
  const width = String(total).length;
  const numbered = srcLines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(width)} | ${line}`)
    .join("\n");
  const omitted: string[] = [];
  if (from > 1) omitted.push(`[... omitted lines 1-${from - 1} ...]`);
  if (to < total) omitted.push(`[... omitted lines ${to + 1}-${total} ...]`);
  const scopeNote = complete
    ? "Whole file at capture time"
    : `Lines ${from}-${to} of ${total}`;
  return (
    `${snapshotLabel(f)}\n` +
    `${scopeNote}; gutter \"N | \" is the true line number, not content: cite by it, strip it when quoting or editing. ` +
    `Re-read only for ${complete ? "later state" : "omitted lines or later state"}.\n` +
    `${omitted.length > 0 ? `${omitted.join("\n")}\n` : ""}` +
    `\`\`\`${f.ft ?? ""}\n${numbered}\n\`\`\``
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT) return; // subagents don't get their own bridge

  // Transcript shows one dim line per snapshot; the numbered body is only a
  // ctrl+r expand away, and always reaches the model regardless.
  pi.registerMessageRenderer<SnapshotDetails>(
    SNAPSHOT_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const details = message.details;
      const label = details ? snapshotLabel(details) : "file snapshot";
      const body =
        expanded && typeof message.content === "string"
          ? `\n${message.content}`
          : "";
      const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(`${theme.fg("dim", label)}${body}`, 0, 0));
      return box;
    },
  );

  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) return; // not in tmux — nothing to do
  const sockPath = socketPathForPane(paneId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  type Ack = { ok: true; delivered: string } | { ok: false; error: string };
  const VALID_MODES = new Set(["steer", "followUp", "nextTurn"]);

  const handleLine = (line: string): Ack => {
    const trimmed = line.trim();
    if (!trimmed) return { ok: false, error: "empty line" };
    let payload: {
      text?: string;
      paste?: string;
      file?: FilePayload;
      mode?: "steer" | "followUp" | "nextTurn";
    };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      currentCtx?.ui.notify(
        "tmux-bridge: dropped malformed JSON line",
        "warning",
      );
      return { ok: false, error: "malformed JSON" };
    }

    const requested =
      payload.mode && VALID_MODES.has(payload.mode) ? payload.mode : undefined;
    const idle = currentCtx?.isIdle() ?? true;

    try {
      const f = payload.file;
      if (f && typeof f.content === "string" && typeof f.path === "string") {
        const message = {
          customType: SNAPSHOT_MESSAGE_TYPE,
          content: formatFileSnapshot(f),
          display: true,
          details: { path: f.path, sline: f.sline, eline: f.eline },
        };
        const where = displayPath(f.path);
        // Idle: land in the transcript now. "nextTurn" instead holds the
        // snapshot back and injects it *after* the next user message (see
        // _pendingNextTurnMessages in agent-session), so the model reads the
        // question before the code it refers to, and until that prompt is sent
        // nothing confirms the selection arrived at all.
        if (idle && !requested) {
          pi.sendMessage<SnapshotDetails>(message, { triggerTurn: false });
          return { ok: true, delivered: `${where} added to context` };
        }
        // Mid-run, steering is the earliest safe insertion point: appending
        // straight into a live request risks splitting a tool_use from its
        // tool_result. Delivery lands after the current assistant turn's tool
        // calls, and steeringMode "one-at-a-time" (the default) releases one
        // queued snapshot per turn.
        const deliverAs = requested ?? "steer";
        pi.sendMessage<SnapshotDetails>(message, { deliverAs });
        return {
          ok: true,
          delivered:
            deliverAs === "nextTurn"
              ? `${where} attached to your next prompt`
              : `${where} ${deliverAs === "steer" ? "steering the running turn" : "queued as follow-up"}`,
        };
      }
      const paste = payload.paste;
      if (typeof paste === "string") {
        currentCtx?.ui.pasteToEditor(`${paste}\n`);
        return { ok: true, delivered: "pasted into the editor" };
      }
      const text = payload.text;
      if (!text || typeof text !== "string")
        return { ok: false, error: "no text, paste, or file in payload" };
      // Idle, the message triggers its own turn and deliverAs is rejected.
      if (idle) {
        pi.sendUserMessage(text);
        return { ok: true, delivered: "sent, turn started" };
      }
      // A user message must be answered, so "nextTurn" has no meaning here;
      // the nearest delivery is once the current run finishes.
      const deliverAs =
        requested === "followUp" || requested === "nextTurn"
          ? "followUp"
          : "steer";
      pi.sendUserMessage(text, { deliverAs });
      return {
        ok: true,
        delivered:
          deliverAs === "followUp"
            ? "queued as follow-up"
            : "steering the running turn",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      currentCtx?.ui.notify(`tmux-bridge: ${msg}`, "error");
      return { ok: false, error: msg };
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
    // A whole-file snapshot is a legitimate payload, so the cap only has to
    // stop a runaway peer; the client refuses to send anywhere near it.
    const MAX_BUF = 2 * 1024 * 1024;
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
          socket.write(
            `${JSON.stringify({ ok: false, error: "payload too large" })}\n`,
          );
          socket.end();
          return;
        }
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          socket.write(`${JSON.stringify(handleLine(line))}\n`);
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
