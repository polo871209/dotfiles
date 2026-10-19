import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

type Btw = { question: string; answer: string };

const INSTRUCTION =
  "Side question asked with /btw. Answer briefly from the conversation so far and do not call tools. The exchange stays out of the main conversation.";

const card = ({ question, answer }: Btw, theme: Theme) => {
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(
    new Text(`${theme.fg("accent", theme.bold("btw"))} ${question}`, 0, 0),
  );
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(answer, 0, 0, getMarkdownTheme()));
  return box;
};

const answerText = (message: AssistantMessage) =>
  message.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
    .trim();

// Providers reject a tool call without its result, which the transcript has while a tool runs.
const withoutOpenToolCalls = (messages: Message[]) => {
  const answered = new Set(
    messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );
  const open = messages.findIndex(
    (m) =>
      m.role === "assistant" &&
      m.content.some((c) => c.type === "toolCall" && !answered.has(c.id)),
  );
  return open < 0 ? messages : messages.slice(0, open);
};

async function ask(
  ctx: ExtensionContext,
  question: string,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<string> {
  if (!ctx.model) throw new Error("no model selected");
  const transcript = withoutOpenToolCalls(
    convertToLlm(ctx.sessionManager.buildSessionProjection().messages),
  );
  const stream = ctx.modelRegistry.streamSimple(
    ctx.model,
    {
      systemPrompt:
        transcript[0]?.role === "system" ? undefined : ctx.getSystemPrompt(),
      messages: [
        ...transcript,
        {
          role: "user",
          content: `${INSTRUCTION}\n\n${question}`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      // Same session id and thinking level as the main agent, so the provider reuses its prompt cache.
      sessionId: ctx.sessionManager.getSessionId(),
      reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
      signal,
    },
  );
  for await (const event of stream) {
    if (event.type === "text_delta") onText(answerText(event.partial));
  }
  const result = await stream.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage ?? result.stopReason);
  }
  return answerText(result) || "(no answer)";
}

export default function (pi: ExtensionAPI) {
  let running: AbortController | undefined;

  pi.registerEntryRenderer<Btw>(
    "btw",
    (entry, _options, theme) => entry.data && card(entry.data, theme),
  );

  pi.on("session_shutdown", () => running?.abort());

  const run = async (ctx: ExtensionContext, question: string) => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const show = (answer: string) =>
      ctx.ui.setWidget(
        "btw",
        (_tui, theme) => card({ question, answer }, theme),
        {
          placement: "aboveEditor",
        },
      );
    show("…");
    try {
      const answer = await ask(ctx, question, controller.signal, show);
      pi.appendEntry<Btw>("btw", { question, answer });
      if (ctx.mode !== "tui") ctx.ui.notify(answer, "info");
    } catch (error) {
      if (!controller.signal.aborted) {
        ctx.ui.notify(
          `btw: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    } finally {
      if (running === controller) {
        running = undefined;
        ctx.ui.setWidget("btw", undefined);
      }
    }
  };

  pi.registerCommand("btw", {
    description:
      "Ask a side question with the session as context; the answer stays out of it",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
      void run(ctx, question);
    },
  });
}
