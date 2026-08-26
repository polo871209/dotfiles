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
//   {"text": "hello"}                     -- send immediately, triggers a turn
//   {"paste": "some reference text"}      -- drop into pi's own input editor, no turn
//   {"file": {"path": ..., "sline": ..., "eline": ..., "ft": ..., "content": ...}}
//                                          -- format a line-numbered snapshot and drop
//                                             that into pi's own input editor, no turn
//
// "paste"/"file" land in the real pi editor (ctx.ui.pasteToEditor) rather than
// being sent as a message directly, so the user finishes composing there with
// full slash-command support and pi's own completion — neither exists in an
// nvim-side input prompt.
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

function socketPathForPane(paneId: string): string {
  const safe = paneId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `pi-tmux-pane-${safe}.sock`);
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
  const rangeNote = complete
    ? "This is the complete file snapshot at capture time."
    : `This bounded snapshot includes the selected lines plus ${SURROUNDING_LINES} surrounding lines where available.`;
  const readNote = complete
    ? `Read \`${f.path}\` only if later state is needed.`
    : `Read \`${f.path}\` only if omitted context or later state is needed.`;
  return (
    `${f.path} — ${rangeNote} Selected range: lines ${f.sline}-${f.eline}. ${readNote} ` +
    `Each line has a true source-number gutter (\"N | code\"); use it for exact citations. ` +
    `The gutter is not file content: strip \"N | \" when quoting or editing.\n` +
    `${omitted.length > 0 ? `${omitted.join("\n")}\n` : ""}` +
    `\`\`\`${f.ft ?? ""}\n${numbered}\n\`\`\``
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT) return; // subagents don't get their own bridge
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) return; // not in tmux — nothing to do
  const sockPath = socketPathForPane(paneId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: {
      text?: string;
      paste?: string;
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
        // Drop the formatted snapshot into pi's own input editor instead of
        // sending it as a message: the user finishes composing there, with
        // full slash-command support and pi's completion, and sends it
        // themselves whenever they're ready.
        const ui = currentCtx?.ui;
        if (ui) {
          // pi-tui's editor collapses any paste over 10 lines/1000 chars into
          // a bare "[paste #N +M lines]" marker with no path/line info, fed
          // straight to the cursor with no trailing newline. Feed the header
          // as its own short paste so it stays literal text instead of
          // collapsing (keeps the range visible pre-send and doubles as the
          // "content is already below, no re-read needed" cue for pi), then
          // a final "\n" paste so typing lands on a fresh line instead of
          // glued to the marker.
          ui.pasteToEditor(`${f.path} (L${f.sline}-${f.eline}):\n`);
          ui.pasteToEditor(formatFileSnapshot(f));
          ui.pasteToEditor("\n");
        }
        return;
      }
      const paste = payload.paste;
      if (typeof paste === "string") {
        currentCtx?.ui.pasteToEditor(`${paste}\n`);
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
