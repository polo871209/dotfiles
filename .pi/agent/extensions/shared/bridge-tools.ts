// Registry of extension tools exposed to eval cells as `tool.<name>(...)`.
//
// Pi loads every extension in an isolated jiti module graph (moduleCache:
// false), so a module-level singleton here would NOT be shared across
// extensions — the registry must live on globalThis, keyed once per process.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface BridgeableTool {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
}

const KEY = "__piEvalBridgeTools";

function registry(): Map<string, BridgeableTool> {
  const g = globalThis as { [KEY]?: Map<string, BridgeableTool> };
  return (g[KEY] ??= new Map());
}

/**
 * Wrap `pi.registerTool` so every tool this extension registers is also
 * callable from eval cells. Call once at the top of the extension's default().
 * Idempotent across hot reloads (registry entries are overwritten by name).
 */
export function exposeRegisteredToolsToEval(pi: ExtensionAPI): void {
  const orig = pi.registerTool.bind(pi);
  pi.registerTool = ((def: Parameters<ExtensionAPI["registerTool"]>[0]) => {
    registry().set(def.name, def as unknown as BridgeableTool);
    orig(def);
  }) as ExtensionAPI["registerTool"];
}

/** Tools other extensions opted in to exposing, by name. */
export function evalBridgeTools(): ReadonlyMap<string, BridgeableTool> {
  return registry();
}
