import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

type RowKind = "option" | "other" | "next";
type SentinelKind = Exclude<RowKind, "option">;

interface RowIntentMeta {
  label: string;
  activatesInputMode: boolean;
  blocksMultiToggle: boolean;
  autoSubmitsInMulti: boolean;
  autoAppendOnSingleSelect: boolean;
  autoAppendOnMultiSelect: boolean;
}

export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
  option: {
    label: "",
    activatesInputMode: false,
    blocksMultiToggle: false,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: false,
    autoAppendOnMultiSelect: false,
  },
  other: {
    label: "Type something.",
    activatesInputMode: true,
    blocksMultiToggle: true,
    autoSubmitsInMulti: false,
    autoAppendOnSingleSelect: true,
    autoAppendOnMultiSelect: true,
  },
  next: {
    label: "Next",
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

const RESERVED_LABELS = [
  "Other",
  ROW_INTENT_META.other.label,
  ROW_INTENT_META.next.label,
] as const;

export function sentinelsToAppend(question: QuestionData): SentinelKind[] {
  const out: SentinelKind[] = [];
  for (const k of ["other", "next"] satisfies readonly SentinelKind[]) {
    const meta = ROW_INTENT_META[k];
    if (question.multiSelect === true) {
      if (meta.autoAppendOnMultiSelect) out.push(k);
    } else if (meta.autoAppendOnSingleSelect) {
      out.push(k);
    }
  }
  return out;
}

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    description: `Very short chip/tag shown next to the question (aim for ≤${MAX_HEADER_LENGTH} chars). Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(
    Type.Object({
      label: Type.String({
        description: `Display text for the option (1-5 words, aim for ≤${MAX_LABEL_LENGTH} chars). If recommending one, put it first and append "(Recommended)". Reserved labels: "Other", "Type something.", "Next".`,
      }),
      description: Type.String({
        description:
          "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
      }),
    }),
    {
      description: `Available choices (soft limit ${2}-${MAX_OPTIONS}). Every question gets a free-text row, so a question with one authored option remains usable. Keep choices distinct unless multiSelect is enabled.`,
    },
  ),
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
    description: `Questions to ask the user (soft limit ${MAX_QUESTIONS})`,
  }),
});

export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  custom?: string;
}

type QuestionnaireError =
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

type ValidationResult =
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
    if (q.options.length === 0) {
      return {
        ok: false,
        error: "empty_options",
        message: "Error: Each question requires at least one option",
      };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (
        (new Set(RESERVED_LABELS) satisfies ReadonlySet<string>).has(o.label)
      ) {
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

const DECLINE_MESSAGE = "User declined to answer questions";
const NO_INPUT_PLACEHOLDER = "(no input)";

export function formatAnswerScalar(a: QuestionAnswer): string {
  switch (a.kind) {
    case "multi": {
      const parts = [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])];
      return parts.length > 0 ? parts.join(", ") : NO_INPUT_PLACEHOLDER;
    }
    case "custom":
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case "option":
      return a.answer ?? NO_INPUT_PLACEHOLDER;
  }
}

function buildAnswerSegment(a: QuestionAnswer, echoQuestion: boolean): string {
  const answer = formatAnswerScalar(a);
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
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a, params.questions.length > 1));
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result.answers,
      cancelled: true,
    });
  }
  return buildToolResult(`${"User answered:"} ${segments.join(" ")}`, result);
}
