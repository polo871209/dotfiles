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
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

// Minimal caveman-mode system prompt. No edit/tool restrictions needed —
// `complete()` is called with no `tools`, so the model has no edit ability.
const SIDE_PROMPT =
  "Caveman mode. One short sentence. No preamble. No suggestions. Plain text.";

const WIDGET_KEY = "btw-answer";
// Single-bar prefix per line, no width-dependent borders. Lines are
// colored rosewater (catppuccin #f5e0dc) via direct truecolor ANSI so the
// styling only affects this widget.
// `\x1b[2m` adds the faint/dim intensity attribute so the rosewater
// reads muted instead of vivid. `\x1b[22;39m` resets both.
const ROSE = "\x1b[2;38;2;245;224;220m";
const RESET = "\x1b[22;39m";
const BAR = `${ROSE}▎ `;
const rose = (s: string) => `${ROSE}${s}${RESET}`;
const MAX_WIDTH = 100;

// crude word-wrap that respects existing newlines and code fences.
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence || raw.length <= width) {
      out.push(raw);
      continue;
    }
    let line = raw;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Auto-clear the answer widget when the user submits their next prompt.
  pi.on("before_agent_start", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined as never);
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

      // Build context from current branch — keep only user/assistant text;
      // drop tool calls/results to keep payload small for a side question.
      const branch = ctx.sessionManager.getBranch();
      const messages: UserMessage[] = [];
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
                    (c): c is { type: "text"; text: string } =>
                      c.type === "text",
                  )
                  .map((c) => c.text)
                  .join("\n");
          if (text) {
            messages.push({
              role: "user",
              content: [{ type: "text", text }],
              timestamp: m.timestamp ?? Date.now(),
            });
          }
        } else if (m.role === "assistant") {
          const text = m.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");
          if (text) {
            messages.push({
              role: "assistant" as never,
              content: [{ type: "text", text }],
              timestamp: m.timestamp ?? Date.now(),
            } as never);
          }
        }
      }
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

          const run = async () => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
              ctx.model!,
            );
            if (!auth.ok || !auth.apiKey) {
              throw new Error(
                auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error,
              );
            }
            const response = await complete(
              ctx.model!,
              {
                systemPrompt: SIDE_PROMPT,
                messages: messages as never,
              },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                signal: loader.signal,
              },
            );
            if (response.stopReason === "aborted") return null;
            return response.content
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text",
              )
              .map((c) => c.text)
              .join("\n")
              .trim();
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

      const lines = [
        rose(`${BAR}btw`),
        rose(`${BAR}Q: ${question}`),
        rose(BAR),
        ...wrap(result, MAX_WIDTH).map((l) => rose(`${BAR}${l}`)),
      ];
      // Pass a factory function so we bypass pi's 10-line cap on
      // array-style widgets (which truncates with "... (widget truncated)").
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, _theme) => {
          const container = new Container();
          for (const line of lines) {
            container.addChild(new Text(line, 1, 0));
          }
          return container;
        },
        { placement: "aboveEditor" } as never,
      );
    },
  });
}
