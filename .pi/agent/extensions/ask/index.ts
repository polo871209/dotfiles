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
  MIN_OPTIONS,
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

const DESCRIPTION = `Present the user with one or more structured multiple-choice questions and wait for their answer. This is the PRIMARY way to resolve ambiguity — reach for it directly instead of guessing or asking in plain prose, and call it in the SAME turn you hit the ambiguity (don't first write out the question as text).

Call it when the request is ambiguous (underspecified, multiple valid readings, or an assumption the user would want a say in), or to offer a clear set of directions to take.

Mechanics:
- Up to ${MAX_QUESTIONS} questions per call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options. Group all clarifying questions into ONE call — never stack back-to-back calls.
- header / label length limits are soft: over-long values auto-truncate, NEVER rejected — don't avoid the tool or pad/trim to fit.
- Single-select questions get a free-text "Type something." row automatically; the user can also pick "Chat about this" to abandon and talk it through.
- Set multiSelect: true when multiple answers are valid (suppresses the free-text row).
- If you recommend an option, make it FIRST and append "(Recommended)" to its label.
- Do NOT author options labeled "Other", "Type something.", "Chat about this", or "Next" — reserved, rejected.`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: DESCRIPTION,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured multiple-choice questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) instead of guessing when a request is ambiguous`,
    promptGuidelines: [
      "Underspecified request, blocked without a concrete decision → ask_user_question, same turn, not prose. See description for the full mechanics.",
    ],
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) =>
          new QuestionnaireSession({
            tui,
            theme,
            params: typed,
            itemsByTab,
            done,
          }).component,
      );

      return buildQuestionnaireResponse(result, typed);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
