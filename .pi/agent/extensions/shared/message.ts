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

interface TextMessage {
  role: "user" | "assistant";
  text: string;
}

export function textMessages(branch: readonly unknown[]): TextMessage[] {
  const out: TextMessage[] = [];
  for (const entry of branch) {
    const e = entry as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (e.type !== "message" || !e.message) continue;
    const { role, content } = e.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(content).trim();
    if (text) out.push({ role, text });
  }
  return out;
}

export const lastAssistantText = (
  branch: readonly unknown[],
): string | undefined =>
  textMessages(branch)
    .filter((m) => m.role === "assistant")
    .at(-1)?.text;
