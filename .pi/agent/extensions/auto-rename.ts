import { basename, isAbsolute, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isForkName } from "./shared/fork-name";
import { extractText } from "./shared/message";
import {
  sideChannelComplete,
  sideChannelWithLoader,
  type SideChannelOpts,
} from "./shared/llm";

const MAX_WORDS = 5;
const MAX_CHARS = 40;
const RENAME_AT_USER_TURNS = [1, 3];
const ENTRY_TYPE = "auto-rename";

interface AutoRenameEntry {
  turns: number;
  name?: string;
}
const DANGLING_WORD =
  /^(and|or|for|with|without|of|the|a|an|to|in|into|on|at|by|via|vs|from)$/i;

interface FileEditCall {
  type: "toolCall";
  name: "edit" | "write";
  arguments: { path: string };
}

function isFileEditCall(c: unknown): c is FileEditCall {
  const call = c as Partial<FileEditCall> | null;
  return (
    call?.type === "toolCall" &&
    (call.name === "edit" || call.name === "write") &&
    typeof call.arguments?.path === "string"
  );
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function cleanTitle(raw: string): string {
  return (raw.trim().split("\n")[0] ?? "")
    .replace(/^["'`*#\s]+|["'`*\s]+$/g, "")
    .replace(/[.!?,;:]+$/, "")
    .replace(/\s+/g, " ");
}

function fitsLimits(title: string): boolean {
  return title.split(" ").length <= MAX_WORDS && title.length <= MAX_CHARS;
}

function capTitle(title: string): string {
  const words = title.split(" ").filter(Boolean).slice(0, MAX_WORDS);
  while (words.length > 1 && words.join(" ").length > MAX_CHARS) words.pop();
  while (words.length > 1 && DANGLING_WORD.test(words.at(-1)!)) words.pop();
  return words.join(" ");
}

async function finalTitle(
  ctx: ExtensionContext,
  digest: string,
  reply: string,
  signal?: AbortSignal,
): Promise<string> {
  const title = cleanTitle(reply);
  if (fitsLimits(title)) return title;
  const retry = await sideChannelComplete(ctx, {
    ...nameRequest(
      ctx,
      `${digest}\n\nYour title "${title}" is too long. Name the same topic in ${MAX_WORDS} words or fewer, ${MAX_CHARS} characters at most.`,
    ),
    signal,
  });
  return capTitle(retry.ok ? cleanTitle(retry.text) : title);
}

function lastAutoRename(ctx: ExtensionContext): AutoRenameEntry | undefined {
  let last: AutoRenameEntry | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE)
      last = entry.data as AutoRenameEntry;
  }
  return last;
}

function sessionDigest(
  ctx: ExtensionContext,
  pendingRequest?: string,
): {
  text: string;
  userTurns: number;
} {
  const requests: string[] = [];
  const edits = new Map<string, number>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const { role, content } = entry.message as {
      role?: string;
      content?: unknown;
    };
    if (role === "user") {
      const text = extractText(content).trim();
      if (text) requests.push(text);
    } else if (role === "assistant" && Array.isArray(content)) {
      for (const call of content.filter(isFileEditCall)) {
        const path = call.arguments.path;
        const rel = isAbsolute(path) ? relative(ctx.cwd, path) : path;
        const shown = rel.startsWith("..") ? path : rel;
        edits.set(shown, (edits.get(shown) ?? 0) + 1);
      }
    }
  }
  if (pendingRequest?.trim()) requests.push(pendingRequest.trim());

  const [latest, ...earlier] = [...requests].reverse();
  const sections = [`Latest request:\n${clip(latest ?? "", 2_000)}`];
  if (earlier.length)
    sections.push(
      `Earlier requests, newest first:\n${earlier
        .slice(0, 10)
        .map((r) => `- ${clip(r, 300)}`)
        .join("\n")}`,
    );
  if (edits.size)
    sections.push(
      `Files edited most:\n${[...edits]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([path, count]) => `- ${path} (${count})`)
        .join("\n")}`,
    );
  return { text: sections.join("\n\n"), userTurns: requests.length };
}

function nameRequest(ctx: ExtensionContext, text: string): SideChannelOpts {
  const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-5-5");
  return {
    systemPrompt: `You title coding-agent sessions with 2 to ${MAX_WORDS} words. Name the key topic: the one thing the session builds, fixes, or investigates now. Requests come newest first, and each one weighs more than the ones after it. The latest request decides the topic. Use earlier requests and the files edited most only to name that topic precisely, or when the latest request has no topic of its own, such as "go on" or "fix it".

Rules:
- 2 to ${MAX_WORDS} words and ${MAX_CHARS} characters at most. Sentence case. No quotes, no final punctuation.
- Drop words a reader can infer: "Slow unit tests on CI", not "Fix the slow unit tests on the GitHub runner".
- Name the concrete subject: the feature, file, tool, command, or error, with the project's own names.
- One topic. Never join two topics with "and" or a comma.
- No filler: session, discussion, help, improving, refinement, updates, various.

Good: Worktree switching | Auto-rename weights latest request | Kulala HTTP setup | Subagent status leak
Bad: Shared LSP daemon socket path for every Nvim instance (too long) | Session naming and rename command (two topics) | Agent refinement (vague) | Improving SYSTEM.md guidelines (filler)

Reply with the title only.`,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    ],
    join: " ",
    model:
      model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  const inFlight = new Set<string>();

  const tryRename = async (ctx: ExtensionContext, pendingRequest?: string) => {
    if (!ctx.model) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || inFlight.has(sessionFile)) return;

    const { text, userTurns } = sessionDigest(ctx, pendingRequest);
    const currentName = pi.getSessionName();
    let digest = text;
    let dueTurns: number;
    if (isForkName(currentName)) {
      if (!pendingRequest) return;
      dueTurns = userTurns;
      digest += `\n\nThis session branched off a session about "${currentName}". Name the topic of the latest request, because that is where this branch goes. Pick a title that tells this branch apart from that session.`;
    } else {
      dueTurns =
        RENAME_AT_USER_TURNS.filter((turns) => userTurns >= turns).at(-1) ?? 0;
      const last = lastAutoRename(ctx);
      const namedByHand = !!currentName && currentName !== last?.name;
      if (namedByHand || dueTurns <= (last?.turns ?? 0)) return;
    }

    inFlight.add(sessionFile);
    try {
      const signal = AbortSignal.timeout(40_000);
      const result = await sideChannelComplete(ctx, {
        ...nameRequest(ctx, digest),
        signal,
      });
      if (!result.ok) return;
      const name = await finalTitle(ctx, digest, result.text, signal);
      if (!name) return;

      if (ctx.sessionManager.getSessionFile() !== sessionFile) return;
      if (pi.getSessionName() !== currentName) return;

      pi.setSessionName(name);
      pi.appendEntry<AutoRenameEntry>(ENTRY_TYPE, { turns: dueTurns, name });
    } finally {
      inFlight.delete(sessionFile);
    }
  };

  const renameInBackground = (
    ctx: ExtensionContext,
    pendingRequest?: string,
  ) => {
    void tryRename(ctx, pendingRequest).catch(() => {});
  };
  const showSessionNameAsTitle = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(pi.getSessionName() ?? basename(ctx.cwd));
  };

  // Pi emits message_end before it stores the message, so the prompt is passed along.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    renameInBackground(ctx, extractText(event.message.content));
  });
  pi.on("session_start", (_e, ctx) => {
    renameInBackground(ctx);
    // Pi writes its own "\u03c0 - name - cwd" title after session_start handlers return.
    setTimeout(() => showSessionNameAsTitle(ctx), 0);
  });
  pi.on("session_info_changed", (_e, ctx) => showSessionNameAsTitle(ctx));

  pi.registerCommand("rename", {
    description:
      "Regenerate the session name ('-': clear it and re-arm the automatic rename)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (arg === "-" || arg.toLowerCase() === "clear") {
        pi.setSessionName("");
        pi.appendEntry<AutoRenameEntry>(ENTRY_TYPE, { turns: 0 });
        ctx.ui.notify("Session name cleared", "info");
        return;
      }

      if (arg) {
        ctx.ui.notify(
          "/rename takes no name. Use /name <name> to set one.",
          "warning",
        );
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      if (sessionFile && inFlight.has(sessionFile)) {
        ctx.ui.notify("A rename is already running", "warning");
        return;
      }

      const { text: digest, userTurns } = sessionDigest(ctx);
      if (userTurns === 0) {
        ctx.ui.notify("Nothing to name yet", "warning");
        return;
      }

      if (sessionFile) inFlight.add(sessionFile);
      try {
        const reply = await sideChannelWithLoader(
          ctx,
          "Naming session",
          nameRequest(ctx, digest),
        );
        if (reply === null) return;
        const name = await finalTitle(ctx, digest, reply);
        if (!name) {
          ctx.ui.notify("Model returned an empty name", "warning");
          return;
        }
        pi.setSessionName(name);
        pi.appendEntry<AutoRenameEntry>(ENTRY_TYPE, { turns: userTurns, name });
        ctx.ui.notify(`Session named: ${name}`, "info");
      } finally {
        if (sessionFile) inFlight.delete(sessionFile);
      }
    },
  });
}
