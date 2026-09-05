// auto-rename — once a session has more than 3 user turns, spawn a
// stateless LLM call to pick a short, descriptive session name.
//
// Pi has no default session title. The selector falls back to the raw first
// user message (`session.name ?? session.firstMessage`), which scans badly
// when the session opens with a pasted log or an `@file` mention. This
// extension hooks `agent_end` and renames via `pi.setSessionName()`.
//
// Trade-off: the selector's "named" filter (keybinding id
// `app.session.toggleNamedFilter`) then matches nearly every session, so it
// stops working as a bookmark. Raise THRESHOLD if you rely on that filter.
//
// Stateless: the rename call is NOT added to session history (mirrors
// btw.ts). Each session is renamed at most once unless the user clears
// the name with `/rename -`.
//
// Usage:
//   /rename                 regenerate the name now, whatever the turn count
//   /rename auth refactor   set the name by hand
//   /rename -               clear the name and re-arm the automatic rename

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectTextMessages } from "./shared/message";
import {
  registerSideModelFlag,
  sideChannelComplete,
  sideChannelWithLoader,
  type SideChannelOpts,
} from "./shared/llm";

// ---- config ----
// Naming a session is cheap classification work, so pin it to Haiku with no
// extended thinking instead of burning the session model. The call falls back
// to PI_SIDE_MODEL and then the session model when this model is missing or
// has no auth. Edit these two lines to move the work to another model.
const NAME_PROVIDER = "anthropic";
const NAME_MODEL = "claude-haiku-4-5";
const NAME_THINKING = false;

const THRESHOLD = 3; // strictly more than this many user turns
const MAX_NAME_LEN = 60;
const MAX_CONTEXT_MESSAGES = 12; // first few turns are enough to name a session
const SYSTEM_PROMPT =
  "You name chat sessions. Reply with ONLY a short title (max 6 words, " +
  "no quotes, no punctuation at end, no trailing period). Describe the " +
  "user's overall task or topic. Plain text only.";
// ---- end config ----

// Trim model chatter down to a label: strip wrapping quotes and trailing
// punctuation, collapse whitespace, cap the width the selector can show.
function normalizeName(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
}

// Single place that builds the side-channel call, so the automatic path and
// /rename always share one model and one prompt.
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
      thinkingEnabled: NAME_THINKING,
    },
    userTurns,
  };
}

export default function (pi: ExtensionAPI) {
  // Sole owner of --side-model for the whole harness. See shared/llm.ts.
  registerSideModelFlag(pi);
  // Per-session-file guard so we don't fire concurrent renames.
  const inFlight = new Set<string>();
  // Sessions we've already renamed in this process; avoid clobbering a
  // user-set name (also checked via getSessionName()).
  const done = new Set<string>();

  const tryRename = async (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
    if (!ctx.model) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    if (inFlight.has(sessionFile) || done.has(sessionFile)) return;
    if (pi.getSessionName()) {
      done.add(sessionFile);
      return;
    }

    const { opts, userTurns } = buildCall(ctx);
    if (userTurns <= THRESHOLD) return;

    inFlight.add(sessionFile);
    try {
      const result = await sideChannelComplete(ctx, opts);
      // Background task: fail silently, never notify.
      if (!result.ok) return;
      const name = normalizeName(result.text);
      if (!name) return;

      // Re-check: user may have set one while we were waiting.
      if (pi.getSessionName()) {
        done.add(sessionFile);
        return;
      }

      pi.setSessionName(name);
      done.add(sessionFile);
    } finally {
      inFlight.delete(sessionFile);
    }
  };

  pi.on("agent_end", (_e, ctx) => tryRename(ctx));
  pi.on("session_start", (_e, ctx) => tryRename(ctx));

  pi.registerCommand("rename", {
    description:
      "Rename the session (no args: regenerate, '-': clear and re-arm auto)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const sessionFile = ctx.sessionManager.getSessionFile();

      // Clear: an empty session_info entry drops the name, so the selector
      // falls back to the first message and the automatic rename re-arms.
      if (arg === "-" || arg.toLowerCase() === "clear") {
        pi.setSessionName("");
        if (sessionFile) done.delete(sessionFile);
        ctx.ui.notify("Session name cleared", "info");
        return;
      }

      // Manual name wins over the automatic one for the rest of the process.
      if (arg) {
        const name = normalizeName(arg);
        if (!name) {
          ctx.ui.notify("Name is empty after normalization", "warning");
          return;
        }
        pi.setSessionName(name);
        if (sessionFile) done.add(sessionFile);
        ctx.ui.notify(`Session named: ${name}`, "info");
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

      // No turn threshold here: the user asked for the rename explicitly.
      if (sessionFile) inFlight.add(sessionFile);
      try {
        const text = ctx.hasUI
          ? await sideChannelWithLoader(ctx, "Naming session", opts)
          : await sideChannelComplete(ctx, opts).then((r) =>
              r.ok ? r.text : null,
            );
        if (text === null) return;
        const name = normalizeName(text);
        if (!name) {
          ctx.ui.notify("Model returned an empty name", "warning");
          return;
        }
        pi.setSessionName(name);
        if (sessionFile) done.add(sessionFile);
        ctx.ui.notify(`Session named: ${name}`, "info");
      } finally {
        if (sessionFile) inFlight.delete(sessionFile);
      }
    },
  });
}
