// /btw — ask a side question without polluting the main conversation.
//
// The question and answer are NOT added to the session message history,
// so the next prompt's LLM call won't see them. The current conversation
// IS sent as context so the side answer can be informed by what came
// before.
//
// The answer widget auto-dismisses when you submit your next prompt or run
// /btw again.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { collectTextMessages, modelVisibleEntries } from "./shared/message";
import { sideChannelWithLoader } from "./shared/llm";
import { barWidget } from "./shared/widget";

// No edit or tool restrictions needed: the side call sends no tools.
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
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Same history the model sees, text only: no tool calls or results, to
      // keep the payload small. Cap at the last 20 messages.
      const { messages } = collectTextMessages(
        modelVisibleEntries(ctx.sessionManager),
        20,
      );

      messages.push({
        role: "user",
        content: [{ type: "text", text: `[SIDE QUESTION] ${question}` }],
        timestamp: Date.now(),
      });

      const result = await sideChannelWithLoader(ctx, `btw → ${ctx.model.id}`, {
        systemPrompt: SIDE_PROMPT,
        messages,
      });

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
