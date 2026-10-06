// Native port of @juicesharp/rpiv-ask-user-question.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildQuestionnaireResponse,
  buildToolResult,
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type QuestionParams,
  QuestionParamsSchema,
  type QuestionnaireResult,
  validateQuestionnaire,
} from "./schema";

import { buildItemsForQuestion, QuestionnaireSession } from "./session";
import type { WrappingSelectItem } from "./widgets";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

function capItems<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}

function clamp(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// pi validates after this runs, so over-limit values get clamped, not rejected.
function clampArguments(args: unknown): QuestionParams {
  if (!isRecord(args) || !Array.isArray(args.questions))
    return args as QuestionParams;
  return {
    ...args,
    questions: capItems(args.questions, MAX_QUESTIONS).map((q) =>
      isRecord(q)
        ? {
            ...q,
            header:
              typeof q.header === "string"
                ? clamp(q.header, MAX_HEADER_LENGTH)
                : q.header,
            options: Array.isArray(q.options)
              ? capItems(q.options, MAX_OPTIONS).map((o) =>
                  isRecord(o) && typeof o.label === "string"
                    ? { ...o, label: clamp(o.label, MAX_LABEL_LENGTH) }
                    : o,
                )
              : q.options,
          }
        : q,
    ),
  } as QuestionParams;
}

const DESCRIPTION =
  "Ask an interactive user to choose when a request needs a decision among multiple valid readings or directions. Call in the same turn ambiguity appears, not after prose; do not use when available tools can determine the facts.";

function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: DESCRIPTION,
    promptSnippet: "Structured choice dialog",
    parameters: QuestionParamsSchema,
    prepareArguments: clampArguments,
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: false },
    // pi shows one custom dialog at a time, so two asks in one turn must queue.
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const typed = params as unknown as QuestionParams;
      // RPC reports hasUI but its ui.custom() returns undefined at once.
      if (ctx.mode !== "tui")
        return {
          ...buildToolResult(ERROR_NO_UI, {
            answers: [],
            cancelled: true,
            error: "no_ui",
          }),
          isError: true,
        };

      const validation = validateQuestionnaire(typed);
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

      const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) =>
        buildItemsForQuestion(q),
      );

      let onAbort: (() => void) | undefined;
      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          onAbort = () => done({ answers: [], cancelled: true });
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          return new QuestionnaireSession({
            tui,
            theme,
            params: typed,
            itemsByTab,
            done,
          }).component;
        },
      );
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);

      return buildQuestionnaireResponse(result, typed);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
