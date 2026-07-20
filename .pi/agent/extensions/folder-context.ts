// folder-context — when the agent touches a path via read/edit/write/grep/
// find/ls, walk from that path's dir up to (but NOT including) the session
// cwd and inject every ancestor's AGENTS.md (or CLAUDE.md). cwd itself is
// skipped — pi already loads the cwd's AGENTS.md as project context. Paths
// outside cwd are ignored.
//
// Priority per dir: AGENTS.md > CLAUDE.md. README.md is intentionally NOT a
// candidate — it's unbounded prose, and as steer context it rides every
// subsequent turn. A candidate is loaded at most once per session (mtime
// changes mid-session are not picked up — restart to refresh).
//
// Injection rides the `context` hook (fires before every LLM call, including
// mid-turn calls after a tool result), not before_agent_start (fires once
// per outer user turn, before the tool loop starts) or a one-off steer
// message (ages into buried history). Appending on `context` means a folder
// discovered by tool N is visible to the LLM call that follows tool N —
// same turn, no need to wait for the next user prompt. (before_agent_start
// would land in the literal system-prompt string, but pi serializes these
// custom messages as role "user" either way, so that purity buys nothing
// — not worth trading away same-turn immediacy for.)

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CustomMessage } from "@earendil-works/pi-agent-core";

const CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;
const TARGET_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
  // Subagents get a clean context: only their own agent .md + tools, no
  // ambient repo docs injected mid-run.
  if (process.env.PI_IS_SUBAGENT === "1") return;

  // candidate abs path → true once loaded (never reloaded, even on edit)
  const injected = new Set<string>();
  // Accumulated blocks, resent in full on every `context` call (not stored in
  // session history) so the rule stays present for as long as the session
  // cares about that folder, without waiting for the next user turn.
  const blocks: string[] = [];

  pi.on("session_start", () => {
    injected.clear();
    blocks.length = 0;
  });

  pi.on("context", (event) => {
    if (!blocks.length) return;
    const msg: CustomMessage = {
      role: "custom",
      customType: "folder-context",
      content: blocks.join("\n\n"),
      display: false,
      timestamp: Date.now(),
    };
    return { messages: [...event.messages, msg] };
  });

  pi.on("tool_result", async (event, ctx) => {
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
        if (injected.has(candidate)) break; // already loaded this session

        try {
          const content = readFileSync(candidate, "utf-8");
          injected.add(candidate);
          blocks.push(
            `Folder context loaded from \`${candidate}\`:\n\n${content}`,
          );
        } catch {
          // allow retry on next call
        }
        break; // first match in this dir wins
      }
    }
  });
}
