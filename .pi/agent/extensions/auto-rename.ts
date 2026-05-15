// auto-rename — once a session has more than 3 user turns, spawn a
// stateless LLM call to pick a short, descriptive session name.
//
// Default session labels (timestamps / first prompt slug) are usually
// confusing after a couple of turns. This extension fixes that by
// hooking `agent_end` and renaming via `pi.setSessionName()`.
//
// Stateless: the rename call is NOT added to session history (mirrors
// btw.ts). Each session is renamed at most once unless the user clears
// the name manually.

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THRESHOLD = 3; // strictly more than this many user turns
const SYSTEM_PROMPT =
  "You name chat sessions. Reply with ONLY a short title (max 6 words, " +
  "no quotes, no punctuation at end, no trailing period). Describe the " +
  "user's overall task or topic. Plain text only.";

export default function (pi: ExtensionAPI) {
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

    const branch = ctx.sessionManager.getBranch();

    // Collect user/assistant text-only messages and count user turns.
    const messages: UserMessage[] = [];
    let userTurns = 0;
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (!("role" in m)) continue;
      if (m.role === "user") {
        const text =
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter(
                  (c): c is { type: "text"; text: string } => c.type === "text",
                )
                .map((c) => c.text)
                .join("\n");
        if (!text) continue;
        userTurns++;
        messages.push({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: m.timestamp ?? Date.now(),
        });
      } else if (m.role === "assistant") {
        const text = m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (!text) continue;
        messages.push({
          role: "assistant" as never,
          content: [{ type: "text", text }],
          timestamp: m.timestamp ?? Date.now(),
        } as never);
      }
    }

    if (userTurns <= THRESHOLD) return;

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

    inFlight.add(sessionFile);
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok || !auth.apiKey) return;

      const response = await complete(
        ctx.model,
        { systemPrompt: SYSTEM_PROMPT, messages: messages as never },
        { apiKey: auth.apiKey, headers: auth.headers },
      );
      if (response.stopReason === "aborted") return;

      const raw = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .trim();
      // Normalize: strip surrounding quotes, trailing punctuation, collapse ws.
      const name = raw
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[.!?,;:]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (!name) return;

      // Re-check: user may have set one while we were waiting.
      if (pi.getSessionName()) {
        done.add(sessionFile);
        return;
      }

      pi.setSessionName(name);
      done.add(sessionFile);
      ctx.ui.notify(`Session renamed: ${name}`, "info");
    } catch (e) {
      // Silent: renaming is best-effort.
      ctx.ui.notify(
        `auto-rename failed: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    } finally {
      inFlight.delete(sessionFile);
    }
  };

  pi.on("agent_end", (_e, ctx) => tryRename(ctx));
  pi.on("session_start", (_e, ctx) => tryRename(ctx));
}
