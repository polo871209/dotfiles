import type {
  ClassifierApi,
  ClassifierBoolQuestion,
  ClassifierModel,
  JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JevModel = ClassifierModel<ClassifierApi>;

export async function findJev(
  ctx: ExtensionContext,
): Promise<JevModel | undefined> {
  try {
    const available = await ctx.modelRegistry.getAvailableOfType(
      "classifier",
      "typesafe",
    );
    return available.find((model) => model.id === "jev-latest");
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
): Promise<Record<string, number> | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const result = await ctx.modelRegistry.classify(jev, context, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (result.stopReason !== "stop") return null;
  const probabilities: Record<string, number> = {};
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type === "bool") probabilities[key] = answer.probability;
  }
  return probabilities;
}
