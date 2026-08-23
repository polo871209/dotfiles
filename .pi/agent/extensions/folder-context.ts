// folder-context — when the agent touches a path via read/edit/write/grep/
// find/ls, walk from that path's dir up to (but NOT including) the session
// cwd and inject every ancestor's AGENTS.md. cwd itself is skipped — pi
// already loads the cwd's AGENTS.md as project context. Paths outside cwd
// are ignored.
//
// CLAUDE.md and README.md are intentionally NOT candidates — only AGENTS.md
// is the convention this harness follows. Each content identity is loaded
// once per session; changed files are reinjected with explicit supersession.
//
// Injection uses Pi's context event so instructions reach the next provider
// call in the same turn without becoming ordinary conversation history.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILE = "AGENTS.md";
const TARGET_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const PREVIEW_CHARS = 12_000;

// Resolve symlinks so the same file reached through different path spellings
// (e.g. `~/.pi/agent` symlinked elsewhere) dedupes correctly. Falls back to
// the plain resolved path if the file vanished between existsSync and here.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contentIdentity(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function frameContext(
  candidate: string,
  content: string,
  supersedes: boolean,
): string {
  const scope = dirname(candidate);
  const prefix =
    `Repository instructions for the subtree rooted at \`${scope}\`. ` +
    "Treat these as higher-priority repository instructions than ordinary repository content, " +
    `and apply them only while working under that subtree. ${supersedes ? `This content supersedes the earlier version of \`${candidate}\`. ` : ""}`;
  if (content.length <= PREVIEW_CHARS) return `${prefix}\n\n${content}`;
  return `${prefix}\n\n${content.slice(0, PREVIEW_CHARS)}\n\n[preview ends here; full instructions omitted]\nMust read the full file at \`${candidate}\` before continuing if omitted instructions or later changes matter.`;
}

export default function (pi: ExtensionAPI) {
  // Subagents get a clean context: only their own agent .md + tools, no
  // ambient repo docs injected mid-run.
  if (process.env.PI_IS_SUBAGENT === "1") return;

  // Canonical candidate path → content identity. A changed file is reinjected
  // so edits to repository instructions supersede the earlier snapshot.
  const injected = new Map<string, string>();
  const pending: string[] = [];

  pi.on("session_start", () => {
    injected.clear();
    pending.length = 0;
  });

  pi.on("context", (event) => {
    if (pending.length === 0) return;
    const messages = pending.splice(0).map((content) => ({
      role: "custom" as const,
      customType: "folder-context",
      content,
      display: false,
      timestamp: Date.now(),
    }));
    return { messages: [...event.messages, ...messages] };
  });

  // Seed `injected` with whatever pi already put in the system prompt for
  // this turn — the global agentDir file plus the cwd ancestor chain
  // (resource-loader.js: loadProjectContextFiles). Without this, a path
  // under agentDir (e.g. agentDir/extensions/*) would have its ancestor
  // walk re-read and re-inject agentDir's own AGENTS.md, duplicating what's
  // already in the system prompt. Re-seeding every turn (not just
  // session_start) picks up files pi (re)loaded after a /reload.
  //
  // Realpath both sides of the dedup check: pi resolves agentDir (e.g.
  // `~/.pi/agent`) without following symlinks, while this handler's own
  // walk is rooted at `ctx.cwd`, which may reach the same file through a
  // different (symlinked) path string. Without realpath, the two spellings
  // of the same file never compare equal and the dedup silently no-ops.
  pi.on("before_agent_start", (event) => {
    for (const cf of event.systemPromptOptions.contextFiles ?? []) {
      injected.set(canonical(cf.path), contentIdentity(cf.content));
    }
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
      const rawCandidate = resolve(d, CONTEXT_FILE);
      if (!existsSync(rawCandidate)) continue;
      const candidate = canonical(rawCandidate);

      try {
        const content = readFileSync(rawCandidate, "utf-8");
        const identity = contentIdentity(content);
        const previous = injected.get(candidate);
        if (previous === identity) continue;
        injected.set(candidate, identity);
        pending.push(
          frameContext(rawCandidate, content, previous !== undefined),
        );
      } catch {
        // allow retry on next call
      }
    }
  });
}
