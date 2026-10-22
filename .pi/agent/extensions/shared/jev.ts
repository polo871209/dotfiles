import type {
  ClassifierApi,
  ClassifierBoolQuestion,
  ClassifierModel,
  JsonObject,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JevModel = ClassifierModel<ClassifierApi>;

export async function findJev(
  ctx: ExtensionContext,
): Promise<JevModel | undefined> {
  try {
    return (
      await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe")
    ).find((model) => model.id === "jev-latest");
  } catch {
    return undefined;
  }
}

export async function boolProbabilities(
  ctx: ExtensionContext,
  jev: JevModel,
  context: {
    state: JsonObject;
    questions: Record<string, ClassifierBoolQuestion>;
  },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ probabilities: Record<string, number> | null; usage?: Usage }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const result = await ctx.modelRegistry.classify(jev, context, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (result.stopReason !== "stop")
    return { probabilities: null, usage: result.usage };
  const probabilities: Record<string, number> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type === "bool") probabilities[key] = answer.probability;
  }
  return { probabilities, usage: result.usage };
}

export function sumUsage(usages: (Usage | undefined)[]): Usage | undefined {
  const present = usages.filter((u): u is Usage => u !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined
      ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) }
      : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  }));
}
