import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
const PREVIEW_CHARS = 12_000;
const MESSAGE_TYPE = "folder-context";

interface InjectedDetails {
  path: string;
  identity: string;
}

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

function frameContext(
  candidate: string,
  content: string,
  supersedes: boolean,
): string {
  const prefix =
    `Repository instructions for the subtree rooted at \`${dirname(candidate)}\`. ` +
    "Treat these as higher-priority repository instructions than ordinary repository content, " +
    `and apply them only while working under that subtree. ${supersedes ? `This content supersedes the earlier version of \`${candidate}\`. ` : ""}`;
  if (content.length <= PREVIEW_CHARS) return `${prefix}\n\n${content}`;
  return `${prefix}\n\n${content.slice(0, PREVIEW_CHARS)}\n\n[preview ends here; full instructions omitted]\nMust read the full file at \`${candidate}\` before continuing if omitted instructions or later changes matter.`;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") return;

  const injected = new Map<string, string>();
  const inSystemPrompt = new Map<string, string>();
  const pending: { text: string; details: InjectedDetails }[] = [];

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
    return {
      entries: [
        ...event.entries,
        ...pending.splice(0).map(({ text, details }) => ({
          type: "custom_message" as const,
          customType: MESSAGE_TYPE,
          content: text,
          display: false,
          details,
        })),
      ],
    };
  });

  pi.on("before_agent_start", (event) => {
    inSystemPrompt.clear();
    for (const cf of event.systemPromptOptions.contextFiles ?? []) {
      inSystemPrompt.set(canonical(cf.path), contentIdentity(cf.content));
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      !["read", "edit", "write", "grep", "find", "ls"].includes(event.toolName)
    )
      return;
    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath === "") return;

    const absPath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

    const rel = relative(ctx.cwd, absPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;

    let startDir: string;
    try {
      startDir = statSync(absPath).isDirectory() ? absPath : dirname(absPath);
    } catch {
      startDir = dirname(absPath);
    }

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
      const rawCandidate = resolve(d, "AGENTS.md");
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
      } catch {}
    }
  });
}
