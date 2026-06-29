// Tool-facing contract for ask_user_question: parameter schema, the row-intent
// metadata table that drives sentinel rows, runtime validation, and the
// LLM-facing answer envelope.
//
// IMPORTANT: the schema deliberately carries NO `maxLength` on header/label.
// Hard length caps in the schema make pi reject the whole tool call before
// execute() runs, forcing the model to retry (the "needs twice to trigger"
// bug). Limits are advisory in the descriptions and enforced by graceful
// truncation in index.ts instead, so the first call always lands.

import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

// Row-intent metadata — single source of truth for the four row kinds.

export type RowKind = "option" | "other" | "chat" | "next";
export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = [
  "other",
  "chat",
  "next",
];

export interface RowIntentMeta {
  label: string;
  reserved: boolean;
  livesInMainList: boolean;
  /** Contributes to the main-list numbering offset the chat row reads. */
  numbered: boolean;
  /** Focusing the row toggles state.inputMode (the inline free-text row). */
  activatesInputMode: boolean;
  /** In multiSelect, Space / Enter-as-toggle is suppressed (the Next row). */
  blocksMultiToggle: boolean;
  /** In multiSelect, Enter commits the question (the Next row). */
  autoSubmitsInMulti: boolean;
  /** Appended by buildItems on single-select questions (the free-text "Other" row). */
  autoAppendOnSingleSelect: boolean;
  /** Appended by buildItems on multi-select questions. */
  autoAppendOnMultiSelect: boolean;
}

export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
  option: {
    label: "",
    reserved: false,
    livesInMainList: true,
    numbered: true,
    activatesInputMode: false,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: false,
  },
  other: {
    label: "Type something.",
    reserved: true,
    livesInMainList: true,
    numbered: true,
    activatesInputMode: true,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: true,
    autoAppendOnMultiSelect: false,
  },
  chat: {
    label: "Chat about this",
    reserved: true,
    livesInMainList: false,
    numbered: true,
    activatesInputMode: false,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: false,
  },
  next: {
    label: "Next",
    reserved: true,
    livesInMainList: true,
    numbered: false,
    activatesInputMode: false,
    blocksMultiToggle: true,
    autoSubmitsInMulti: true,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: true,
  },
};

export function sentinelLabel(kind: SentinelKind): string {
  return ROW_INTENT_META[kind].label;
}

/** "Other" is model-conditioned (CC parity) and reserved on top of the runtime sentinels. */
export const RESERVED_LABELS = [
  "Other",
  ROW_INTENT_META.other.label,
  ROW_INTENT_META.chat.label,
  ROW_INTENT_META.next.label,
] as const;

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

/** Synthesize the sentinel rows appended to one question's option list. */
export function sentinelsToAppend(question: QuestionData): SentinelKind[] {
  const out: SentinelKind[] = [];
  for (const k of SENTINEL_KINDS) {
    const meta = ROW_INTENT_META[k];
    if (!meta.livesInMainList) continue;
    if (question.multiSelect === true) {
      if (meta.autoAppendOnMultiSelect) out.push(k);
    } else if (meta.autoAppendOnSingleSelect) {
      out.push(k);
    }
  }
  return out;
}

// Parameter schema (no hard length caps — see file header).

export const OptionSchema = Type.Object({
  label: Type.String({
    description: `The display text for this option that the user will see and select. Should be concise (1-5 words, aim for ≤${MAX_LABEL_LENGTH} chars). Over-long labels are auto-truncated, never rejected.`,
  }),
  description: Type.String({
    description:
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
  }),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    description: `Very short chip/tag shown next to the question (aim for ≤${MAX_HEADER_LENGTH} chars). Examples: "Auth method", "Library", "Approach". Over-long headers are auto-truncated, never rejected.`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description:
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    }),
  ),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "Questions to ask the user (1-4 questions)",
  }),
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

// Answer model + result.

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
}

export type QuestionnaireError =
  | "no_ui"
  | "no_questions"
  | "empty_options"
  | "too_many_questions"
  | "duplicate_question"
  | "duplicate_option_label"
  | "reserved_label";

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?: QuestionnaireError;
}

// Validation. Length is NOT validated here (clamped in index.ts). Covers the
// semantic guards only; no_ui stays inline at the call site.

export type ValidationResult =
  { ok: true } | { ok: false; error: QuestionnaireError; message: string };

export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
  if (typed.questions.length === 0) {
    return {
      ok: false,
      error: "no_questions",
      message: "Error: At least one question is required",
    };
  }
  if (typed.questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: "too_many_questions",
      message: `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`,
    };
  }

  const seenQuestions = new Set<string>();
  for (const q of typed.questions) {
    if (seenQuestions.has(q.question)) {
      return {
        ok: false,
        error: "duplicate_question",
        message: "Error: Question text must be unique within an invocation",
      };
    }
    seenQuestions.add(q.question);
  }

  for (const q of typed.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return {
        ok: false,
        error: "empty_options",
        message: `Error: Each question requires at least ${MIN_OPTIONS} options`,
      };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (RESERVED_LABEL_SET.has(o.label)) {
        return {
          ok: false,
          error: "reserved_label",
          message: `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`,
        };
      }
      if (seenLabels.has(o.label)) {
        return {
          ok: false,
          error: "duplicate_option_label",
          message: "Error: Option labels must be unique within a question",
        };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}

// Answer formatting + LLM-facing envelope.

export const DECLINE_MESSAGE = "User declined to answer questions";
const ENVELOPE_PREFIX = "User answered:";
const CHAT_CONTINUATION_MESSAGE =
  "User wants to chat about this. Continue the conversation to help them decide.";
export const CHAT_SUMMARY_MESSAGE = "User wants to chat about this";
const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

export function formatAnswerScalar(
  a: QuestionAnswer,
  variant: FormatAnswerVariant,
): string {
  switch (a.kind) {
    case "chat":
      return variant === "envelope"
        ? CHAT_CONTINUATION_MESSAGE
        : CHAT_SUMMARY_MESSAGE;
    case "multi":
      return a.selected && a.selected.length > 0
        ? a.selected.join(", ")
        : NO_INPUT_PLACEHOLDER;
    case "custom":
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case "option":
      return a.answer ?? NO_INPUT_PLACEHOLDER;
  }
}

function buildAnswerSegment(a: QuestionAnswer, echoQuestion: boolean): string {
  const answer = formatAnswerScalar(a, "envelope");
  // Single-question calls: the question is still fresh in the agent's context
  // (it emitted the tool call this turn), so echoing it back is dead tokens.
  return echoQuestion ? `"${a.question}"="${answer}"` : answer;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
  return { content: [{ type: "text" as const, text }], details };
}

export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
) {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
    });
  }
  const segments: string[] = [];
  const echoQuestion = params.questions.length > 1;
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a, echoQuestion));
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result.answers,
      cancelled: true,
    });
  }
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")}`, result);
}
