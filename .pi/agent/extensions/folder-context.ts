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
// Injection returns a hidden custom message from turn_end. Pi persists it
// right after the turn's tool results, so it reaches the next provider call in
// the same run and every call after it. The context event is no substitute:
// its changes apply to one request only, and the instructions vanished after
// that request.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CONTEXT_FILE = "AGENTS.md";
const TARGET_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const PREVIEW_CHARS = 12_000;
const MESSAGE_TYPE = "folder-context";

interface InjectedDetails {
  path: string;
  identity: string;
}

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
  // Files pi itself put in the system prompt, seeded per prompt.
  const inSystemPrompt = new Map<string, string>();
  const pending: { text: string; details: InjectedDetails }[] = [];

  // Rebuild from what the model can still see: a compaction summarizes the
  // messages away, and /tree can move to a branch that never had them.
  const syncFromContext = (ctx: ExtensionContext): void => {
    injected.clear();
    for (const m of ctx.sessionManager.buildSessionProjection().messages) {
      if (m.role !== "custom" || m.customType !== MESSAGE_TYPE) continue;
      const d = m.details as InjectedDetails | undefined;
      if (d?.path && d.identity) injected.set(d.path, d.identity);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    pending.length = 0;
    syncFromContext(ctx);
  });
  pi.on("session_compact", (_event, ctx) => syncFromContext(ctx));
  pi.on("session_tree", (_event, ctx) => syncFromContext(ctx));

  pi.on("turn_end", (event) => {
    if (pending.length === 0) return;
    const drafts = pending.splice(0).map(({ text, details }) => ({
      type: "custom_message" as const,
      customType: MESSAGE_TYPE,
      content: text,
      display: false,
      details,
    }));
    return { entries: [...event.entries, ...drafts] };
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
    inSystemPrompt.clear();
    for (const cf of event.systemPromptOptions.contextFiles ?? []) {
      inSystemPrompt.set(canonical(cf.path), contentIdentity(cf.content));
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
        if (inSystemPrompt.get(candidate) === identity) continue;
        const previous = injected.get(candidate);
        if (previous === identity) continue;
        injected.set(candidate, identity);
        pending.push({
          text: frameContext(rawCandidate, content, previous !== undefined),
          details: { path: candidate, identity },
        });
      } catch {
        // allow retry on next call
      }
    }
  });
}
