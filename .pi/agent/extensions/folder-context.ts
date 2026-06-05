// folder-context — when the agent touches a path via read/edit/write/grep/
// find/ls, walk from that path's dir up to (but NOT including) the session
// cwd and inject every ancestor's AGENTS.md (or CLAUDE.md, or README.md).
// cwd itself is skipped — pi already loads the cwd's AGENTS.md as project
// context. Paths outside cwd are ignored.
//
// Priority per dir: AGENTS.md > CLAUDE.md > README.md. A candidate re-injects
// only if its on-disk mtime changed since last load (picks up edits).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;
const TARGET_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
  // candidate abs path → mtimeMs at last injection
  const injected = new Map<string, number>();

  pi.on("session_start", () => {
    injected.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!TARGET_TOOLS.has(event.toolName)) return;
    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath === "") return;

    const absPath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

    // Only walk inside cwd; skip paths outside the session root entirely.
    const rel = relative(ctx.cwd, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;

    // Dir-oriented tools (grep/find/ls) pass the directory itself; file tools
    // pass a file. Start the walk at the dir either way.
    let startDir: string;
    try {
      startDir = statSync(absPath).isDirectory() ? absPath : dirname(absPath);
    } catch {
      startDir = dirname(absPath);
    }

    // Walk up to (but not including) cwd. cwd's own AGENTS.md is already
    // loaded by pi as project context — skipping it avoids duplicate injection.
    const ancestors: string[] = [];
    let cur = startDir;
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
        let mtime: number;
        try {
          mtime = statSync(candidate).mtimeMs;
        } catch {
          break;
        }
        if (injected.get(candidate) === mtime) break; // already loaded, unchanged

        injected.set(candidate, mtime);
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
