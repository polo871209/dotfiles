// Side-channel LLM call helper. Stateless: does NOT touch session history.
// Centralizes the auth → complete → filter-text dance used by auto-rename,
// btw, yeet, and lsp-feedback's fixer.
//
// These calls don't need the frontier session model. Set env PI_SIDE_MODEL to
// a cheap model (`provider/id`, e.g. `anthropic/claude-haiku-4-5`) and every
// side-channel call routes there instead — saving cost + latency. Unset, or
// unresolvable / no auth, falls back to the session model (no behavior change).
import {
  complete,
  type Api,
  type Message,
  type Model,
} from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SIDE_MODEL_FLAG = "side-model";

// Two constraints meet here. A flag name belongs to exactly one extension: pi
// scans every loaded extension for a duplicate and fails the later one
// outright, so only one of the four consumers may call registerFlag. And
// getFlag answers only for the extension that registered the name, so the
// other three cannot read it through their own handle.
//
// The owner therefore parks its handle on globalThis, which the loader's
// per-extension module graphs do share. auto-rename.ts is the owner because it
// is the one consumer that registers unconditionally. Read lazily, never at
// load time: a side-channel call always happens well after argument parsing.
const OWNER_KEY = "__piSideModelFlagOwner";

/** Owner side. Call from auto-rename.ts alone, not from the other consumers. */
export function registerSideModelFlag(pi: ExtensionAPI): void {
  pi.registerFlag(SIDE_MODEL_FLAG, {
    type: "string",
    description:
      "Cheap model for side-channel calls (commit messages, session names, /btw), as provider/id. Overrides PI_SIDE_MODEL.",
  });
  // Always overwrite: /reload invalidates the previous handle, and calling
  // getFlag on a stale one throws.
  (globalThis as Record<string, unknown>)[OWNER_KEY] = pi;
}

function sideModelSpec(): string | undefined {
  const owner = (globalThis as Record<string, unknown>)[OWNER_KEY] as
    | ExtensionAPI
    | undefined;
  let flag: unknown;
  try {
    flag = owner?.getFlag(SIDE_MODEL_FLAG);
  } catch {
    /* handle went stale between /reload and the owner re-registering */
  }
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  return process.env.PI_SIDE_MODEL?.trim() || undefined;
}

function resolveSideModel(ctx: ExtensionContext) {
  const spec = sideModelSpec();
  if (!spec) return undefined;
  const slash = spec.indexOf("/");
  if (slash < 1) return undefined;
  const m = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
  return m && ctx.modelRegistry.hasConfiguredAuth(m) ? m : undefined;
}

export interface SideChannelOpts {
  systemPrompt: string;
  messages: Message[];
  signal?: AbortSignal;
  // Joiner for multi-part text content. Defaults to "\n".
  join?: string;
  // Force a specific model instead of PI_SIDE_MODEL / the session model.
  model?: Model<Api>;
  // Explicitly disable extended thinking regardless of the model's default.
  thinkingEnabled?: boolean;
}

export type SideChannelResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: "no-model" | "no-auth" | "aborted" | "error";
      error?: string;
    };

// Interactive variant: run the side-channel call behind a BorderedLoader
// (abortable via its esc handling), notifying on failure. Returns the text,
// or null when aborted / failed — the caller only branches on null.
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
  const model = opts.model ?? resolveSideModel(ctx) ?? ctx.model;
  if (!model) return { ok: false, reason: "no-model" };
  const join = opts.join ?? "\n";
  let auth;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
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
      error: auth.ok ? `No API key for ${model.provider}` : auth.error,
    };
  }
  try {
    const response = await complete(
      model,
      { systemPrompt: opts.systemPrompt, messages: opts.messages },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: opts.signal,
        ...(opts.thinkingEnabled !== undefined
          ? { thinkingEnabled: opts.thinkingEnabled }
          : {}),
      },
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
