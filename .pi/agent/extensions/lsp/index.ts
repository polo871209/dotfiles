// lsp — the LSP subsystem, backed by a persistent headless nvim it owns
// (warm-spawned at session_start by the feedback pass, else lazy on first tool
// call; torn down on session shutdown). Two halves:
//   - Navigation (pull): one `lsp` tool with an action enum (hover,
//     definition, references, implementation, type_definition,
//     document_symbols, and the on-demand read-only diagnostics).
//   - Feedback pass (push, ./feedback): formats edits inline and runs batched
//     diagnostics + LLM auto-fix after a turn. See ./feedback/index.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDriver, isRunning, shutdownNvim } from "./nvim";
import { exposeRegisteredToolsToEval } from "../shared/bridge-tools";
import { registerFeedback } from "./feedback";
import { lspTool } from "./tool";
import { displayPath } from "./utils";

interface StatusResult {
  ok: boolean;
  files?: { file: string; bufnr: number; clients: string[] }[];
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);
  pi.registerTool(lspTool);

  registerFeedback(pi);

  pi.registerCommand("lsp-status", {
    description:
      "Show LSP server status: running, open buffers, attached clients.",
    handler: async (_args, ctx) => {
      if (!isRunning()) {
        ctx.ui.notify(
          "LSP server not running — starts automatically on first use.",
          "info",
        );
        return;
      }
      try {
        const res = await callDriver<StatusResult>(
          ctx.cwd,
          "status",
          [],
          undefined,
        );
        const files = res.files ?? [];
        if (files.length === 0) {
          ctx.ui.notify("nvim running, no buffers open", "info");
          return;
        }
        const lines = files
          .map(
            (f) =>
              `  ${displayPath(f.file, ctx.cwd)}  [${f.clients.join(", ") || "no LSP"}]`,
          )
          .join("\n");
        ctx.ui.notify(
          `nvim running, ${files.length} buffer(s):\n${lines}`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(
          `lsp-status failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("lsp-restart", {
    description: "Reset the LSP server; the next navigation call starts fresh.",
    handler: async (_args, ctx) => {
      const was = isRunning();
      shutdownNvim();
      ctx.ui.notify(was ? "nvim killed" : "nvim was not running", "info");
    },
  });

  pi.on("session_shutdown", () => {
    shutdownNvim();
  });
}
