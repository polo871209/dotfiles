// Wire format for nvim/lua/pi.lua: one JSON object per line, e.g.
//   {"text": "hello"}                     -- send immediately, triggers a turn
//   {"paste": "some reference text"}      -- drop into pi's own input editor, no turn
//   {"file": {"path": ..., "sline": ..., "eline": ..., "ft": ..., "content": ..., "total": ...}}
//                                          -- line-numbered snapshot of the selected
//                                             lines only, pasted into the editor as
//                                             part of the next prompt
// Optional "mode": "steer" | "followUp" | "nextTurn" turns a snapshot into a
// queued custom message instead, the only way to reach an already running turn.
//
// Each line is answered with one JSON line, {"ok":true,"delivered":<where>} or
// {"ok":false,"error":...}, so the client can report what actually happened
// instead of assuming a successful write means the message landed.
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
  return path.join(
    os.tmpdir(),
    `pi-tmux-pane-${paneId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${process.pid}.sock`,
  );
}

function removeDeadSockets(paneId: string): void {
  const prefix = path
    .basename(socketPathForPane(paneId))
    .replace(/-\d+\.sock$/, "-");
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue;
    const pid = Number(name.slice(prefix.length, -".sock".length));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid) {
      try {
        process.kill(pid, 0);
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") continue;
      }
    }
    try {
      fs.unlinkSync(path.join(os.tmpdir(), name));
    } catch {}
  }
}

let sessionCwd = process.cwd();
function displayPath(filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(sessionCwd, filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}

type FilePayload = {
  path: string;
  sline: number;
  eline: number;
  ft?: string;
  /** The selected lines only, starting at `sline`. */
  content: string;
  /** Line count of the whole file, so the header can say what was left out. */
  total?: number;
};

const SNAPSHOT_MESSAGE_TYPE = "tmux-bridge-file";
const GUTTER_SEP = " | ";

type SnapshotDetails = { path: string; sline: number; eline: number };

function snapshotLabel(d: SnapshotDetails): string {
  return `${displayPath(d.path)} (L${d.sline}-${d.eline})`;
}

function formatFileSnapshot(f: FilePayload): string {
  const srcLines = f.content.split(/\r?\n/);
  const from = Math.max(Math.floor(f.sline), 1);
  const to = from + srcLines.length - 1;
  return (
    `${displayPath(f.path)} lines ${from}-${to} of ${f.total && Math.floor(f.total) >= to ? Math.floor(f.total) : to}. The "<n>${GUTTER_SEP}" gutter is line numbers, not file content.\n` +
    `\`\`\`${f.ft ?? ""}\n${srcLines
      .map((line, i) => `${from + i}${GUTTER_SEP}${line}`)
      .join("\n")}\n\`\`\``
  );
}

// pi's editor expands every tab to EDITOR_TAB_WIDTH spaces on paste (pi-tui
// components/editor.ts, normalizeText), and the edit tool's fuzzy fallback
// forgives trailing whitespace and unicode lookalikes but not tab-vs-space. A
// tab-indented file would therefore yield oldText that never matches, so the
// pasted snapshot has to carry the rule for reversing the expansion.
const EDITOR_TAB_WIDTH = 4;

function tabFidelityNote(content: string): string {
  if (!content.includes("\t")) return "";
  return (
    `\nThis file indents with tabs, shown above as ${EDITOR_TAB_WIDTH} spaces each. ` +
    `Turn leading ${EDITOR_TAB_WIDTH}-space groups back into tabs in oldText, or read the file if its indentation looks mixed.`
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") return;

  pi.registerMessageRenderer<SnapshotDetails>(
    SNAPSHOT_MESSAGE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const details = message.details;
      const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
      box.addChild(
        new Text(
          `${theme.fg("dim", details ? snapshotLabel(details) : "file snapshot")}${
            expanded && typeof message.content === "string"
              ? `\n${message.content}`
              : ""
          }`,
          0,
          0,
        ),
      );
      return box;
    },
  );

  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) return;
  const sockPath = socketPathForPane(paneId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  type Ack = { ok: true; delivered: string } | { ok: false; error: string };

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
      payload.mode &&
      ["steer", "followUp", "nextTurn"].includes(payload.mode)
        ? payload.mode
        : undefined;
    const idle = currentCtx?.isIdle() ?? true;

    try {
      const f = payload.file;
      if (f && typeof f.content === "string" && typeof f.path === "string") {
        const content = formatFileSnapshot(f);
        const where = displayPath(f.path);
        if (!requested) {
          if (!currentCtx) return { ok: false, error: "no session context" };
          if (!currentCtx.hasUI)
            return { ok: false, error: "this pi has no editor to paste into" };
          currentCtx.ui.pasteToEditor(
            `${content}${tabFidelityNote(f.content)}\n`,
          );
          return { ok: true, delivered: `${where} pasted into the editor` };
        }
        pi.sendMessage<SnapshotDetails>(
          {
            customType: SNAPSHOT_MESSAGE_TYPE,
            content,
            display: true,
            details: { path: f.path, sline: f.sline, eline: f.eline },
          },
          { deliverAs: requested },
        );
        return {
          ok: true,
          delivered:
            requested === "nextTurn" || idle
              ? `${where} attached to your next prompt`
              : `${where} ${requested === "steer" ? "steering the running turn" : "queued as follow-up"}`,
        };
      }
      const paste = payload.paste;
      if (typeof paste === "string") {
        if (!currentCtx?.hasUI)
          return { ok: false, error: "this pi has no editor to paste into" };
        currentCtx.ui.pasteToEditor(`${paste}\n`);
        return { ok: true, delivered: "pasted into the editor" };
      }
      const text = payload.text;
      if (!text || typeof text !== "string")
        return { ok: false, error: "no text, paste, or file in payload" };
      if (idle) {
        pi.sendUserMessage(text);
        return { ok: true, delivered: "sent, turn started" };
      }
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
    sessionCwd = ctx.cwd;
    if (server) {
      currentCtx = ctx;
      return;
    }
    currentCtx = ctx;
    removeDeadSockets(paneId);
    server = net.createServer((socket: net.Socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > 2 * 1024 * 1024) {
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
      socket.on("error", () => {});
    });
    server.on("error", (err: Error) => {
      ctx.ui?.notify?.(`tmux-bridge: ${err.message}`, "error");
    });
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {}
    });
  };

  const stop = () => {
    if (!server) return;
    server.close();
    server = undefined;
    try {
      fs.unlinkSync(sockPath);
    } catch {}
  };

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    start(ctx);
  });
  pi.on("session_shutdown", async () => {
    stop();
  });
}
