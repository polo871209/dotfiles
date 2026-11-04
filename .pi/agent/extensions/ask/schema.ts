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

const RESERVED_LABELS: readonly string[] = [
  "Other",
  ROW_INTENT_META.other.label,
  ROW_INTENT_META.next.label,
];

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
    description: "The full question, ending with a question mark.",
  }),
  header: Type.String({
    description: `Short tag shown next to the question, at most ${MAX_HEADER_LENGTH} characters, such as "Auth method".`,
  }),
  options: Type.Array(
    Type.Object({
      label: Type.String({
        description: `Option text, 1 to 5 words, at most ${MAX_LABEL_LENGTH} characters. Put a recommended option first and end its label with "(Recommended)". "Other", "Type something.", and "Next" are reserved.`,
      }),
      description: Type.String({
        description:
          "What choosing this option means, including its trade-off.",
      }),
    }),
    {
      description: `1 to ${MAX_OPTIONS} distinct choices. The user can always type a free-text answer instead.`,
    },
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: "Allow several answers when the options are not exclusive.",
    }),
  ),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: `1 to ${MAX_QUESTIONS} questions.`,
  }),
});

export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

const QuestionnaireErrorSchema = Type.Union([
  Type.Literal("no_ui"),
  Type.Literal("no_questions"),
  Type.Literal("empty_options"),
  Type.Literal("duplicate_question"),
  Type.Literal("duplicate_option_label"),
  Type.Literal("reserved_label"),
]);

const QuestionAnswerSchema = Type.Object({
  questionIndex: Type.Number(),
  question: Type.String(),
  kind: Type.Union([
    Type.Literal("option"),
    Type.Literal("custom"),
    Type.Literal("multi"),
  ]),
  answer: Type.Union([Type.String(), Type.Null()]),
  selected: Type.Optional(Type.Array(Type.String())),
  custom: Type.Optional(Type.String()),
});

export const QuestionnaireResultSchema = Type.Object({
  answers: Type.Array(QuestionAnswerSchema),
  cancelled: Type.Boolean(),
  error: Type.Optional(QuestionnaireErrorSchema),
});

export type QuestionAnswer = Static<typeof QuestionAnswerSchema>;
export type QuestionnaireResult = Static<typeof QuestionnaireResultSchema>;
type QuestionnaireError = Static<typeof QuestionnaireErrorSchema>;

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
      if (RESERVED_LABELS.includes(o.label)) {
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
  return {
    content: [{ type: "text" as const, text }],
    details,
    structuredContent: details,
  };
}

export function buildQuestionnaireResponse(
  result: QuestionnaireResult,
  params: QuestionParams,
) {
  if (result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result.answers,
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
  return buildToolResult(`User answered: ${segments.join(" ")}`, result);
}
