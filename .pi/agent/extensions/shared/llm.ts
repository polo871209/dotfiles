// Side-channel LLM call: one request through the model registry that never
// touches session history. Used by auto-rename, btw, yeet, and eval's
// completion helper. No reasoning option is passed, so thinking stays off.
import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SideChannelOpts {
  systemPrompt: string;
  messages: Message[];
  signal?: AbortSignal;
  // Joiner for multi-part text content. Defaults to "\n".
  join?: string;
  // Defaults to the session model.
  model?: Model<Api>;
}

export type SideChannelResult =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; reason: "no-model" | "aborted" | "error"; error?: string };

// Interactive variant: run the call behind a BorderedLoader (esc aborts),
// notifying on failure. Returns null when aborted or failed.
export async function sideChannelWithLoader(
  ctx: ExtensionContext,
  label: string,
  opts: Omit<SideChannelOpts, "signal">,
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, label);
    loader.onAbort = () => done(null);
    void (async () => {
      const r = await sideChannelComplete(ctx, {
        ...opts,
        signal: loader.signal,
      });
      if (r.ok) return done(r.text);
      if (r.reason !== "aborted") {
        ctx.ui.notify(`${label}: ${r.error ?? r.reason}`, "error");
      }
      done(null);
    })();
    return loader;
  });
}

export async function sideChannelComplete(
  ctx: ExtensionContext,
  opts: SideChannelOpts,
): Promise<SideChannelResult> {
  const model = opts.model ?? ctx.model;
  if (!model) return { ok: false, reason: "no-model" };
  try {
    const response = await ctx.modelRegistry
      .streamSimple(
        model,
        { systemPrompt: opts.systemPrompt, messages: opts.messages },
        { signal: opts.signal },
      )
      .result();
    if (response.stopReason === "aborted") {
      return { ok: false, reason: "aborted" };
    }
    if (response.stopReason === "error") {
      return { ok: false, reason: "error", error: response.errorMessage };
    }
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(opts.join ?? "\n")
      .trim();
    return { ok: true, text, usage: response.usage };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
