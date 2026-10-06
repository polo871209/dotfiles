import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

interface CollectedBranch {
  messages: Message[];
  userTurns: number;
}

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
    // Providers such as Anthropic reject a conversation that opens with an
    // assistant turn, which the cut can produce.
    while (messages[0]?.role === "assistant") messages.shift();
  }
  return { messages, userTurns };
}

export function modelVisibleEntries(
  sessionManager: ExtensionContext["sessionManager"],
): Array<{ type: "message"; message: Message }> {
  return convertToLlm(sessionManager.buildSessionProjection().messages).map(
    (message) => ({ type: "message", message }),
  );
}
