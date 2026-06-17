// /btw — ask a side question without polluting the main conversation.
//
// The question and answer are NOT added to the session message history,
// so the next prompt's LLM call won't see them. The current conversation
// IS sent as context so the side answer can be informed by what came
// before.
//
// Usage:
//   /btw why does that error happen?
//
// The answer widget auto-dismisses when you submit your next prompt or run
// /btw again.
//
// Inspired by Claude Code's /btw command.
import {
  BorderedLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { collectTextMessages } from "./shared/message";
import { sideChannelComplete } from "./shared/llm";
import { barWidget } from "./shared/widget";

// Minimal caveman-mode system prompt. No edit/tool restrictions needed —
// `complete()` is called with no `tools`, so the model has no edit ability.
const SIDE_PROMPT =
  "Caveman mode. One short sentence. No preamble. No suggestions. Plain text.";

const WIDGET_KEY = "btw-answer";
const MAX_WIDTH = 100;

// Word-wrap that respects existing newlines and code fences. Width is measured
// with visibleWidth so multi-byte glyphs / ANSI don't miscount.
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence || visibleWidth(raw) <= width) {
      out.push(raw);
      continue;
    }
    out.push(...wrapTextWithAnsi(raw, width));
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Auto-clear the answer widget when the user submits their next prompt.
  pi.on("before_agent_start", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerCommand("btw", {
    description: "Ask a side question (not added to conversation history)",
    handler: async (args, ctx) => {
      const question = (args ?? "").trim();
      if (!question) {
        ctx.ui.notify("/btw <question> — usage", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Build context from current branch — user/assistant text only;
      // drop tool calls/results to keep payload small. Cap last 20 turns.
      const { messages } = collectTextMessages(
        ctx.sessionManager.getBranch(),
        20,
      );

      messages.push({
        role: "user",
        content: [{ type: "text", text: `[SIDE QUESTION] ${question}` }],
        timestamp: Date.now(),
      });

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `btw → ${ctx.model!.id}`,
          );
          loader.onAbort = () => done(null);

          const run = async (): Promise<string | null> => {
            const r = await sideChannelComplete(ctx, {
              systemPrompt: SIDE_PROMPT,
              messages,
              signal: loader.signal,
            });
            if (r.ok) return r.text;
            if (r.reason === "aborted") return null;
            throw new Error(r.error ?? r.reason);
          };

          run()
            .then(done)
            .catch((e) => {
              ctx.ui.notify(
                `btw error: ${e instanceof Error ? e.message : String(e)}`,
                "error",
              );
              done(null);
            });

          return loader;
        },
      );

      if (result === null) {
        ctx.ui.notify("btw cancelled", "info");
        return;
      }
      if (!result) {
        ctx.ui.notify("btw: empty response", "warning");
        return;
      }

      const lines = ["btw", `Q: ${question}`, "", ...wrap(result, MAX_WIDTH)];
      ctx.ui.setWidget(WIDGET_KEY, barWidget(lines), {
        placement: "aboveEditor",
      });
    },
  });
}
