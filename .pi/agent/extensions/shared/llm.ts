// Side-channel LLM call helper. Stateless: does NOT touch session history.
// Centralizes the auth → complete → filter-text dance used by auto-rename,
// btw, yeet, and lsp-feedback's fixer.
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SideChannelOpts {
  systemPrompt: string;
  messages: Message[];
  signal?: AbortSignal;
  // Joiner for multi-part text content. Defaults to "\n".
  join?: string;
}

export type SideChannelResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: "no-model" | "no-auth" | "aborted" | "error";
      error?: string;
    };

export async function sideChannelComplete(
  ctx: ExtensionContext,
  opts: SideChannelOpts,
): Promise<SideChannelResult> {
  if (!ctx.model) return { ok: false, reason: "no-model" };
  const join = opts.join ?? "\n";
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false,
      reason: "no-auth",
      error: auth.ok ? `No API key for ${ctx.model.provider}` : auth.error,
    };
  }
  try {
    const response = await complete(
      ctx.model,
      { systemPrompt: opts.systemPrompt, messages: opts.messages },
      { apiKey: auth.apiKey, headers: auth.headers, signal: opts.signal },
    );
    if (response.stopReason === "aborted") {
      return { ok: false, reason: "aborted" };
    }
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(join)
      .trim();
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
