export type Step = { key: string; title?: string; code: string };

export type RunbookStep = { title: string; command: string };

export const runbookSteps = (toolCallId: string, steps: readonly Partial<RunbookStep>[]): Step[] =>
  steps.map((s, i) => ({
    key: `${toolCallId}:${i}`,
    title: s.title,
    code: s.command ?? "",
  }));
