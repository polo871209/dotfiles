import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SideChannelOpts {
  systemPrompt: string;
  messages: Message[];
  signal?: AbortSignal;
  join?: string;
  model?: Model<Api>;
}

type SideChannelResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no-model" | "aborted" | "error"; error?: string };

export async function sideChannelWithLoader(
  ctx: ExtensionContext,
  label: string,
  opts: Omit<SideChannelOpts, "signal">,
): Promise<string | null> {
  if (ctx.mode !== "tui") {
    const r = await sideChannelComplete(ctx, opts);
    if (r.ok) return r.text;
    if (ctx.hasUI) ctx.ui.notify(`${label}: ${r.error ?? r.reason}`, "error");
    return null;
  }
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
    return {
      ok: true,
      text: response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(opts.join ?? "\n")
        .trim(),
    };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
