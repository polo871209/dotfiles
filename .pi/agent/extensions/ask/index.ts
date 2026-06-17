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
import { buildItemsForQuestion, QuestionnaireSession } from "./session";
import type { WrappingSelectItem } from "./widgets";
import { PAD } from "../shared/config";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

/** Truncate to a code-point budget, appending "…" when clipped. Advisory, never rejects. */
function clamp(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Graceful normalization: clamp over-long header/label so the call always lands. */
function clampParams(params: QuestionParams): QuestionParams {
  return {
    questions: params.questions.map((q) => ({
      ...q,
      header: clamp(q.header, MAX_HEADER_LENGTH),
      options: q.options.map((o) => ({
        ...o,
        label: clamp(o.label, MAX_LABEL_LENGTH),
      })),
    })),
  };
}

const DESCRIPTION = `Present the user with one or more structured multiple-choice questions and wait for their answer. This is the PRIMARY way to resolve ambiguity — reach for it directly instead of guessing or asking in plain prose, and call it in the SAME turn you hit the ambiguity (don't first write out the question as text).

Call it when:
1. The request is underspecified and you cannot proceed without a concrete decision.
2. Multiple reasonable interpretations or implementation paths exist.
3. You're about to make an assumption the user would want a say in.
4. You want to offer a clear set of directions to take.

Mechanics:
- Up to ${MAX_QUESTIONS} questions per call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options. Group all clarifying questions into ONE call — never stack back-to-back calls.
- Each option needs a concise label and a description of what it means / its trade-off.
- header / label length limits are soft: over-long values are auto-truncated, NEVER rejected — don't avoid the tool or pad/trim to fit.
- The user can always type a custom answer ("Type something." is appended automatically to single-select questions) or pick "Chat about this" to abandon the questionnaire and talk it through.
- Set multiSelect: true when multiple answers are valid (suppresses the "Type something." row).
- If you recommend an option, make it the FIRST option and append "(Recommended)" to its label.
- Do NOT author options labeled "Other", "Type something.", "Chat about this", or "Next" — these are reserved and rejected.`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: DESCRIPTION,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured multiple-choice questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) instead of guessing when a request is ambiguous`,
    promptGuidelines: [
      `When the user's request is underspecified and you cannot proceed without a concrete decision, call ask_user_question instead of guessing or asking in prose — in the same turn you hit the ambiguity. Group up to ${MAX_QUESTIONS} clarifying questions into ONE call; never stack calls.`,
      `Each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options with a concise label + a description. Header/label length limits are soft (auto-truncated, never rejected) — don't avoid the tool over length.`,
      `Set multiSelect: true when several answers are valid. If you recommend one, make it the first option and append "(Recommended)".`,
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

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) =>
          new QuestionnaireSession({
            tui,
            theme,
            params: typed,
            itemsByTab,
            done,
          }).component,
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "100%",
            // PAD mirrors the harness gutter so the full-width dialog aligns
            // with the padded conversation/editor instead of bleeding edge-to-edge.
            margin: { left: PAD, right: PAD, bottom: 0 },
          },
        },
      );

      return buildQuestionnaireResponse(result, typed);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
