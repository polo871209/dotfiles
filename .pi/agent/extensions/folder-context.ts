// folder-context — when the agent touches a file via read/edit/write,
// inject that folder's AGENTS.md (or CLAUDE.md, or README.md) into the
// conversation once per session. Lets per-folder context (e.g. an
// extension's README) auto-load when the agent starts working there,
// without polluting the global system prompt.
//
// Priority per dir: AGENTS.md > CLAUDE.md > README.md. Only one file
// per dir per session. Dedup is by absolute path.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;
const TARGET_TOOLS = new Set(["read", "edit", "write"]);

export default function (pi: ExtensionAPI) {
  const injected = new Set<string>();

  pi.on("session_start", () => {
    injected.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!TARGET_TOOLS.has(event.toolName)) return;
    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath === "") return;

    const absPath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    const dir = dirname(absPath);

    for (const name of CANDIDATES) {
      const candidate = resolve(dir, name);
      if (injected.has(candidate)) return; // already loaded this dir's file
      if (!existsSync(candidate)) continue;

      injected.add(candidate);
      try {
        const content = readFileSync(candidate, "utf-8");
        pi.sendMessage(
          {
            customType: "folder-context",
            content: `Folder context loaded from \`${candidate}\`:\n\n${content}`,
            display: true,
          },
          { deliverAs: "steer" },
        );
        if (ctx.hasUI) {
          ctx.ui.notify(`Loaded folder context: ${candidate}`, "info");
        }
      } catch {
        injected.delete(candidate); // allow retry on next call
      }
      return; // first match wins per dir
    }
  });
}
