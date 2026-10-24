import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// The temp directory keeps the path under the 104-byte macOS socket limit, and
// macOS clears the sockets that a pi killed with its pane leaves behind.
function socketPathForBlock(blockId: string): string {
  return path.join(os.tmpdir(), `pi-${blockId.replace(/^block:/, "")}.sock`);
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
  content: string;
  total?: number;
};

const SNAPSHOT_MESSAGE_TYPE = "rex-bridge-file";
const LEGACY_SNAPSHOT_MESSAGE_TYPE = "tmux-bridge-file";
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

function lastEditedFile(ctx: ExtensionContext): string | undefined {
  const failedCalls = new Set<string>();
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult" && message.isError) {
      failedCalls.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (
        block.type !== "toolCall" ||
        (block.name !== "edit" && block.name !== "write") ||
        failedCalls.has(block.id)
      )
        continue;
      const filePath = block.arguments.path;
      if (typeof filePath === "string" && filePath !== "")
        return path.resolve(ctx.cwd, filePath);
    }
  }
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") return;

  const renderSnapshot: MessageRenderer<SnapshotDetails> = (
    message,
    { expanded, outputPad },
    theme,
  ) => {
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
  };
  pi.registerMessageRenderer(SNAPSHOT_MESSAGE_TYPE, renderSnapshot);
  pi.registerMessageRenderer(LEGACY_SNAPSHOT_MESSAGE_TYPE, renderSnapshot);

  const blockId = process.env.REX_BLOCK;
  if (!blockId) return;
  const sockPath = socketPathForBlock(blockId);

  let server: net.Server | undefined;
  let currentCtx: ExtensionContext | undefined;

  type Ack =
    | { ok: true; delivered: string }
    | { ok: true; path: string }
    | { ok: false; error: string };

  const handleLine = (line: string): Ack => {
    const trimmed = line.trim();
    if (!trimmed) return { ok: false, error: "empty line" };
    let payload: {
      text?: string;
      paste?: string;
      file?: FilePayload;
      mode?: "steer" | "followUp" | "nextTurn";
      query?: "last_edit";
    };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      currentCtx?.ui.notify(
        "rex-bridge: dropped malformed JSON line",
        "warning",
      );
      return { ok: false, error: "malformed JSON" };
    }

    if (payload.query === "last_edit") {
      if (!currentCtx) return { ok: false, error: "no session context" };
      const filePath = lastEditedFile(currentCtx);
      return filePath
        ? { ok: true, path: filePath }
        : { ok: false, error: "no file edited in this session" };
    }

    const requested =
      payload.mode && ["steer", "followUp", "nextTurn"].includes(payload.mode)
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
      currentCtx?.ui.notify(`rex-bridge: ${msg}`, "error");
      return { ok: false, error: msg };
    }
  };

  const start = (ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    currentCtx = ctx;
    if (server || !ctx.hasUI) return;
    fs.rmSync(sockPath, { force: true });
    server = net.createServer((socket: net.Socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > 2 * 1024 * 1024) {
          currentCtx?.ui.notify("rex-bridge: oversize line dropped", "warning");
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
      ctx.ui?.notify?.(`rex-bridge: ${err.message}`, "error");
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
