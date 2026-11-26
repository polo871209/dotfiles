// Native port of @juicesharp/rpiv-ask-user-question.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import {
  buildQuestionnaireResponse,
  buildToolResult,
  formatAnswerScalar,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type QuestionnaireResult,
  QuestionnaireResultSchema,
  type QuestionParams,
  QuestionParamsSchema,
  validateQuestionnaire,
} from "./schema";
import { buildItemsForQuestion, QuestionnaireSession } from "./session";

function capItems<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}

function clamp(value: string, max: number): string {
  const chars = Array.from(value);

  if (chars.length <= max) return value;

  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const clampQuestions = ({ questions }: QuestionParams): QuestionParams => ({
  questions: capItems(questions, MAX_QUESTIONS).map((q) => ({
    ...q,
    header: clamp(q.header, MAX_HEADER_LENGTH),
    options: capItems(q.options, MAX_OPTIONS).map((o) => ({
      ...o,
      label: clamp(o.label, MAX_LABEL_LENGTH),
    })),
  })),
});

const renderQuestions = (params: Partial<QuestionParams>, theme: Theme, pad: number) => {
  const lines = (params.questions ?? []).flatMap((q) =>
    q?.question
      ? [`${theme.fg("accent", theme.bold(`? ${q.header ?? ""}`))} ${theme.fg("text", q.question)}`]
      : [],
  );

  return new Text(lines.join("\n") || theme.fg("accent", theme.bold("?")), pad, 0);
};

const renderAnswers = (
  result: QuestionnaireResult,
  params: Partial<QuestionParams>,
  theme: Theme,
  pad: number,
) => {
  const questions = params.questions ?? [];

  const lines = [...result.answers]
    .sort((a, b) => a.questionIndex - b.questionIndex)
    .map((a) => {
      const answer = theme.fg("userMessageText", formatAnswerScalar(a));
      const header = questions[a.questionIndex]?.header;

      return questions.length > 1 && header
        ? `${theme.fg("userMessageText", theme.bold(`${header}:`))} ${answer}`
        : answer;
    });

  return new Text(lines.join("\n"), pad, 1, (text) => theme.bg("userMessageBg", text));
};

function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask an interactive user to choose when a request needs a decision among multiple valid readings or directions. Not for answering the user's question, or when tools can determine the facts.",
    parameters: QuestionParamsSchema,
    prepareArguments: (args) => clampQuestions(Value.Parse(QuestionParamsSchema, args)),
    outputSchema: QuestionnaireResultSchema,
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: false },
    renderShell: "self",
    renderCall: (args, theme, context) => renderQuestions(args, theme, context.outputPad),
    renderResult(result, _options, theme, context) {
      const details = result.details;
      const message = result.content.find((c) => c.type === "text")?.text;

      if (!Value.Check(QuestionnaireResultSchema, details) || details.error || context.isError)
        return new Text(theme.fg("error", message ?? "Question failed."), context.outputPad, 0);

      if (details.cancelled) return new Text(theme.fg("dim", "No answer."), context.outputPad, 0);

      return details.answers.length > 0
        ? renderAnswers(details, context.args, theme, context.outputPad)
        : new Container();
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // RPC reports hasUI but its ui.custom() returns undefined at once.
      if (ctx.mode !== "tui")
        return {
          ...buildToolResult("Error: UI not available (running in non-interactive mode)", {
            answers: [],
            cancelled: true,
            error: "no_ui",
          }),
          isError: true,
        };

      const validation = validateQuestionnaire(params);

      if (!validation.ok) {
        return {
          ...buildToolResult(validation.message, {
            answers: [],
            cancelled: true,
            error: validation.error,
          }),
          isError: true,
        };
      }

      let onAbort: (() => void) | undefined;
      let result: QuestionnaireResult;

      try {
        result = await ctx.ui.custom<QuestionnaireResult>(
          (tui, theme, keybindings, done) => {
            onAbort = () => done({ answers: [], cancelled: true });

            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });

            return new QuestionnaireSession({
              tui,
              theme,
              params,
              itemsByTab: params.questions.map(buildItemsForQuestion),
              done,
              keybindings,
            }).component;
          },
          {
            blocked: {
              kind: "question",
              message: params.questions[0].question,
            },
          },
        );
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }

      if (signal?.aborted) throw new Error("Aborted before the user answered.");

      return buildQuestionnaireResponse(result, params);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
