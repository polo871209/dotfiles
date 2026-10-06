import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectTextMessages } from "./shared/message";
import {
  sideChannelComplete,
  sideChannelWithLoader,
  type SideChannelOpts,
} from "./shared/llm";

const NAME_PROVIDER = "anthropic";
const NAME_MODEL = "claude-haiku-4-5";

const RENAME_AFTER_USER_TURNS = 3;
const MAX_NAME_LEN = 60;
const MAX_CONTEXT_MESSAGES = 12;
const RENAME_TIMEOUT_MS = 20_000;
const SYSTEM_PROMPT =
  "You name chat sessions. Reply with ONLY a short title (max 6 words, " +
  "no quotes, no punctuation at end, no trailing period). Describe the " +
  "user's overall task or topic. Plain text only.";

function normalizeName(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

function buildCall(ctx: ExtensionContext): {
  opts: SideChannelOpts;
  userTurns: number;
} {
  const model = ctx.modelRegistry.find(NAME_PROVIDER, NAME_MODEL);
  const { messages, userTurns } = collectTextMessages(
    ctx.sessionManager.getBranch(),
    MAX_CONTEXT_MESSAGES,
  );
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Give a short title for this session. Reply with the title only.",
      },
    ],
    timestamp: Date.now(),
  });
  return {
    opts: {
      systemPrompt: SYSTEM_PROMPT,
      messages,
      join: " ",
      model:
        model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined,
    },
    userTurns,
  };
}

export default function (pi: ExtensionAPI) {
  const inFlight = new Set<string>();
  const settledSessions = new Set<string>();

  const tryRename = async (ctx: ExtensionContext) => {
    if (!ctx.model) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    if (inFlight.has(sessionFile) || settledSessions.has(sessionFile)) return;
    if (pi.getSessionName()) {
      settledSessions.add(sessionFile);
      return;
    }

    const { opts, userTurns } = buildCall(ctx);
    if (userTurns <= RENAME_AFTER_USER_TURNS) return;

    inFlight.add(sessionFile);
    try {
      const result = await sideChannelComplete(ctx, {
        ...opts,
        signal: AbortSignal.timeout(RENAME_TIMEOUT_MS),
      });
      if (!result.ok) return;
      const name = normalizeName(result.text);
      if (!name) return;

      if (ctx.sessionManager.getSessionFile() !== sessionFile) return;
      if (pi.getSessionName()) {
        settledSessions.add(sessionFile);
        return;
      }

      pi.setSessionName(name);
      settledSessions.add(sessionFile);
    } finally {
      inFlight.delete(sessionFile);
    }
  };

  const renameInBackground = (ctx: ExtensionContext) => {
    void tryRename(ctx).catch(() => {});
  };
  pi.on("agent_settled", (_e, ctx) => renameInBackground(ctx));
  pi.on("session_start", (_e, ctx) => renameInBackground(ctx));

  pi.registerCommand("rename", {
    description:
      "Regenerate the session name ('-': clear it and re-arm the automatic rename)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (arg === "-" || arg.toLowerCase() === "clear") {
        pi.setSessionName("");
        if (sessionFile) settledSessions.delete(sessionFile);
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

      const { opts, userTurns } = buildCall(ctx);
      if (userTurns === 0) {
        ctx.ui.notify("Nothing to name yet", "warning");
        return;
      }

      if (sessionFile) inFlight.add(sessionFile);
      try {
        const text = await sideChannelWithLoader(ctx, "Naming session", opts);
        if (text === null) return;
        const name = normalizeName(text);
        if (!name) {
          ctx.ui.notify("Model returned an empty name", "warning");
          return;
        }
        pi.setSessionName(name);
        if (sessionFile) settledSessions.add(sessionFile);
        ctx.ui.notify(`Session named: ${name}`, "info");
      } finally {
        if (sessionFile) inFlight.delete(sessionFile);
      }
    },
  });
}
