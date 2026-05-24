// folder-context — when the agent touches a file via read/edit/write,
// walk from that file's dir up to (but NOT including) the session cwd
// and inject every ancestor's AGENTS.md (or CLAUDE.md, or README.md)
// once per session. cwd itself is skipped — pi already loads the cwd's
// AGENTS.md as project context. Files outside cwd are ignored.
//
// Priority per dir: AGENTS.md > CLAUDE.md > README.md. Each candidate
// loads at most once per session (dedup by absolute path).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

    // Only walk inside cwd; skip files outside the session root entirely.
    const rel = relative(ctx.cwd, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;

    // Walk file's dir up to (but not including) cwd. cwd's own AGENTS.md
    // is already loaded by pi as project context — skipping it here
    // avoids duplicate injection.
    const ancestors: string[] = [];
    let cur = dirname(absPath);
    while (cur !== ctx.cwd) {
      ancestors.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    ancestors.reverse();

    for (const d of ancestors) {
      for (const name of CANDIDATES) {
        const candidate = resolve(d, name);
        if (!existsSync(candidate)) continue;
        if (injected.has(candidate)) break; // already loaded this dir's file

        injected.add(candidate);
        try {
          const content = readFileSync(candidate, "utf-8");
          pi.sendMessage(
            {
              customType: "folder-context",
              content: `Folder context loaded from \`${candidate}\`:\n\n${content}`,
              display: false,
            },
            { deliverAs: "steer" },
          );
        } catch {
          injected.delete(candidate); // allow retry on next call
        }
        break; // first match in this dir wins
      }
    }
  });
}
