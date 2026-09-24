// Shared helpers for extracting text from pi message content and walking
// session branches. Used by extensions that build side-channel LLM payloads
// (auto-rename, btw, copy, subagent, yeet, lsp-feedback).
import type { Message } from "@earendil-works/pi-ai";

// Pi messages carry content as either a plain string or an array of typed
// parts. This pulls text-typed parts out and joins with newlines.
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

export interface CollectedBranch {
  messages: Message[];
  userTurns: number;
}

// Walk a session branch and return only text-only user/assistant messages,
// preserving original message metadata (timestamp/api/provider/etc).
// Cap to the last `maxMessages` entries when set.
export function collectTextMessages(
  branch: readonly unknown[],
  maxMessages?: number,
): CollectedBranch {
  const messages: Message[] = [];
  let userTurns = 0;
  for (const entry of branch) {
    const e = entry as { type?: string; message?: unknown };
    if (e.type !== "message") continue;
    const m = e.message as (Message & { role?: string }) | null;
    if (!m || !("role" in m)) continue;
    if (m.role === "user") {
      const text = extractText((m as { content?: unknown }).content);
      if (!text) continue;
      userTurns++;
      messages.push({ ...m, content: [{ type: "text", text }] });
    } else if (m.role === "assistant") {
      const content = (m as { content?: unknown }).content;
      const textOnly = Array.isArray(content)
        ? content.filter(
            (c: unknown): c is { type: "text"; text: string } =>
              !!c &&
              typeof c === "object" &&
              (c as { type?: unknown }).type === "text" &&
              typeof (c as { text?: unknown }).text === "string",
          )
        : [];
      if (!textOnly.length) continue;
      messages.push({ ...m, content: textOnly });
    }
  }
  if (maxMessages !== undefined && messages.length > maxMessages) {
    messages.splice(0, messages.length - maxMessages);
  }
  return { messages, userTurns };
}
