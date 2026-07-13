// lsp — agent-callable LSP navigation tools backed by a persistent headless
// nvim. Warm-spawned by lsp-feedback on session_start (else lazy on first
// tool call); tears down on session shutdown.
// Diagnostics live in lsp-feedback (push after edits); these are pull-only
// for navigation: hover, definition, references.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDriver, isRunning, shutdownNvim } from "./nvim";
import { hoverTool } from "./tools/hover";
import { definitionTool } from "./tools/definition";
import { referencesTool } from "./tools/references";
import { renameTool } from "./tools/rename";
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
    description: "Kill the persistent nvim. Next lsp_* call respawns cold.",
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
