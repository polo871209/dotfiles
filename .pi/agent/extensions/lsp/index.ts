// lsp — the LSP subsystem, backed by a persistent headless nvim it owns
// (warm-spawned at session_start by the feedback pass, else lazy on first tool
// call; torn down on session shutdown). Two halves:
//   - Navigation tools (pull): hover, definition, type-definition,
//     implementation, references, rename, document symbols, and the on-demand
//     read-only lsp_diagnostics.
//   - Feedback pass (push, ./feedback): formats edits inline and runs batched
//     diagnostics + LLM auto-fix after a turn. See ./feedback/index.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDriver, isRunning, shutdownNvim } from "./nvim";
import { registerFeedback } from "./feedback";
import { hoverTool } from "./tools/hover";
import { definitionTool } from "./tools/definition";
import { referencesTool } from "./tools/references";
import { renameTool } from "./tools/rename";
import { diagnosticsTool } from "./tools/diagnostics";
import { implementationTool, typeDefinitionTool } from "./tools/navigation";
import { documentSymbolsTool } from "./tools/symbols";
import { displayPath } from "./utils";

interface StatusResult {
  ok: boolean;
  files?: { file: string; bufnr: number; clients: string[] }[];
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(hoverTool);
  pi.registerTool(definitionTool);
  pi.registerTool(referencesTool);
  pi.registerTool(renameTool);
  pi.registerTool(diagnosticsTool);
  pi.registerTool(implementationTool);
  pi.registerTool(typeDefinitionTool);
  pi.registerTool(documentSymbolsTool);

  registerFeedback(pi);

  pi.registerCommand("lsp-status", {
    description:
      "Show LSP nvim status: running? open buffers? attached clients?",
    handler: async (_args, ctx) => {
      if (!isRunning()) {
        ctx.ui.notify(
          "nvim not running (warms at session_start; else on first lsp_* call)",
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
