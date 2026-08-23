// ask — registers the `ask_user_question` tool: a tabbed questionnaire dialog
// the model presents instead of guessing when a request is underspecified.
// Single + multi-select, an "Other" free-text fallback, a chat escape hatch,
// and a Submit/review tab.
//
// Native port of @juicesharp/rpiv-ask-user-question (i18n dropped). The schema
// carries NO hard length caps — over-long header/label values are clamped here
// in execute() rather than rejected pre-call, so the model's first invocation
// always lands (the prior "needs twice to trigger" failure mode).

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

/** Drop excess items instead of rejecting — same "first call always lands" reasoning as clamp(). */
function capItems<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}
import { buildItemsForQuestion, QuestionnaireSession } from "./session";
import type { WrappingSelectItem } from "./widgets";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

/** Truncate to a code-point budget, appending "…" when clipped. Advisory, never rejects. */
function clamp(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Graceful normalization: clamp over-long header/label and cap array sizes so the call always lands. */
function clampParams(params: QuestionParams): QuestionParams {
  return {
    questions: capItems(params.questions, MAX_QUESTIONS).map((q) => ({
      ...q,
      header: clamp(q.header, MAX_HEADER_LENGTH),
      options: capItems(q.options, MAX_OPTIONS).map((o) => ({
        ...o,
        label: clamp(o.label, MAX_LABEL_LENGTH),
      })),
    })),
  };
}

const DESCRIPTION =
  "Ask an interactive user to choose when a request needs a decision among multiple valid readings or directions. Call in the same turn ambiguity appears, not after prose; do not use when available tools can determine the facts.";

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: DESCRIPTION,
    promptSnippet: "Structured choice dialog",
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const raw = params as unknown as QuestionParams;
      if (!ctx.hasUI)
        return buildToolResult(ERROR_NO_UI, {
          answers: [],
          cancelled: true,
          error: "no_ui",
        });

      const typed = clampParams(raw);

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return buildToolResult(validation.message, {
          answers: [],
          cancelled: true,
          error: validation.error,
        });
      }

      const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) =>
        buildItemsForQuestion(q),
      );

      // Inline (non-overlay): replaces the editor instead of floating over the
      // scrollback, so the conversation stays visible and is pushed up above the
      // dialog rather than hidden behind it.
      // Turn abort must tear the dialog down instead of leaving it waiting
      // for an answer that no longer has a consumer.
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
