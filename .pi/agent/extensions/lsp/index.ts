// lsp — the LSP subsystem, backed by shared headless nvim daemons (see
// nvim.ts): connected at session_start by the feedback pass, else lazily on
// first tool call, and left running for other pi processes at shutdown. Two
// halves:
//   - Navigation (pull): one `lsp` tool with an action enum (hover,
//     definition, references, implementation, type_definition,
//     document_symbols, and the on-demand read-only diagnostics).
//   - Feedback pass (push, ./feedback): formats edits inline and runs batched
//     diagnostics + LLM auto-fix after a turn. See ./feedback/index.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDriver, daemonInfo, disconnectNvim, restartDaemons } from "./nvim";
import { exposeRegisteredToolsToEval } from "../shared/bridge-tools";
import { registerFeedback } from "./feedback";
import { lspTool } from "./tool";
import { displayPath } from "./utils";

interface StatusResult {
  ok: boolean;
  files?: { file: string; bufnr: number; clients: string[] }[];
  servers?: { name: string; id: number; root?: string; bufs: number }[];
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);
  pi.registerTool(lspTool);

  registerFeedback(pi);

  pi.registerCommand("lsp-status", {
    description:
      "Show LSP server status: running, open buffers, attached clients.",
    handler: async (_args, ctx) => {
      try {
        const info = await daemonInfo(ctx.cwd);
        const res = await callDriver<StatusResult>(
          ctx.cwd,
          "status",
          [],
          undefined,
        );
        const lines: string[] = [];
        if (info)
          lines.push(
            `daemon pid ${info.pid}, up ${Math.round(info.uptime_s / 60)}m, ${info.rss_mb} MB`,
            `shared with ${info.clients} pi process(es): ${info.client_pids.join(", ")}`,
          );
        for (const s of res.servers ?? [])
          lines.push(
            `  ${s.name}  ${s.bufs} buf(s)  ${s.root ? displayPath(s.root, ctx.cwd) : ""}`,
          );
        for (const f of res.files ?? [])
          lines.push(
            `  ${displayPath(f.file, ctx.cwd)}  [${f.clients.join(", ") || "no LSP"}]`,
          );
        ctx.ui.notify(lines.join("\n") || "nvim running, nothing open", "info");
      } catch (e) {
        ctx.ui.notify(
          `lsp-status failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("lsp-restart", {
    description:
      "Kill the shared nvim daemons (all pi sessions) and start fresh on next use.",
    handler: async (_args, ctx) => {
      const killed = await restartDaemons();
      ctx.ui.notify(
        killed ? "nvim daemons killed" : "no nvim daemon running",
        "info",
      );
    },
  });

  // Disconnect only. The daemons are shared with other pi processes and reap
  // themselves once the last client leaves.
  pi.on("session_shutdown", () => {
    disconnectNvim();
  });
}
