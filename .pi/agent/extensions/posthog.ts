import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

type PropertyValue = string | number | boolean | string[] | undefined;

interface CapturedEvent {
  event: string;
  uuid: string;
  timestamp: string;
  properties: Record<string, PropertyValue>;
}

const PosthogConfig = Type.Object({ token: Type.String({ pattern: "^phc_" }) });

const ToolArgs = Type.Record(Type.String(), Type.Unknown());

type ToolArgs = Static<typeof ToolArgs>;

const ScalarArg = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
const BashArgs = Type.Object({ command: Type.String() });
const ReadArgs = Type.Object({ path: Type.String() });

const ParameterFields = Type.Object({ properties: Type.Record(Type.String(), Type.Unknown()) });

const RequiredChoice = Type.Union([
  Type.Object({ type: Type.Literal("boolean") }),
  Type.Object({ enum: Type.Array(Type.Unknown()) }),
  Type.Object({ const: Type.Unknown() }),
]);

const FixedChoice = Type.Union([
  RequiredChoice,
  Type.Object({
    anyOf: Type.Array(Type.Union([RequiredChoice, Type.Object({ type: Type.Literal("null") })])),
  }),
]);

const ToolResult = Type.Object({
  content: Type.Array(
    Type.Union([
      Type.Object({ type: Type.Literal("text"), text: Type.String() }),
      Type.Object({ type: Type.Literal("image") }),
    ]),
  ),
});

function readToken() {
  const path = join(getAgentDir(), "posthog.json");

  if (!existsSync(path)) return undefined;

  const config = JSON.parse(readFileSync(path, "utf8"));

  if (!Value.Check(PosthogConfig, config))
    throw new Error(`${path}: "token" must be a phc_ project token`);

  return config.token;
}

type UsageProperties = {
  $ai_cache_reporting_exclusive: true;
  $ai_input_tokens: number;
  $ai_output_tokens: number;
  $ai_cache_read_input_tokens: number;
  $ai_cache_creation_input_tokens: number;
  $ai_cache_creation_1h_input_tokens?: number;
  $ai_cache_creation_5m_input_tokens?: number;
  reasoning_tokens?: number;
  $ai_input_cost_usd?: number;
  $ai_output_cost_usd?: number;
  $ai_total_cost_usd?: number;
};

function usageProperties(usage: Usage) {
  const { cost } = usage;

  const properties: UsageProperties = {
    // PostHog assumes cache-inclusive input for non-Anthropic providers, but pi-ai reports input without cache tokens for all of them.
    $ai_cache_reporting_exclusive: true,
    $ai_input_tokens: usage.input,
    $ai_output_tokens: usage.output,
    $ai_cache_read_input_tokens: usage.cacheRead,
    $ai_cache_creation_input_tokens: usage.cacheWrite,
    reasoning_tokens: usage.reasoning,
  };

  if (usage.cacheWrite1h !== undefined) {
    properties.$ai_cache_creation_1h_input_tokens = usage.cacheWrite1h;
    properties.$ai_cache_creation_5m_input_tokens = usage.cacheWrite - usage.cacheWrite1h;
  }

  if (cost.total > 0) {
    properties.$ai_input_cost_usd = cost.input + cost.cacheRead + cost.cacheWrite;
    properties.$ai_output_cost_usd = cost.output;
    properties.$ai_total_cost_usd = cost.total;
  }

  return properties;
}

function extensionName({ path }: ToolInfo["sourceInfo"]): string {
  const file = basename(path);

  return /^index\.[cm]?[jt]s$/.test(file)
    ? basename(dirname(path))
    : file.replace(/\.[cm]?[jt]s$/, "");
}

function definitionChars(tool: ToolInfo): number {
  return (
    tool.description.length +
    JSON.stringify(tool.parameters).length +
    (tool.promptGuidelines?.join("\n").length ?? 0)
  );
}

function argProperties(args: ToolArgs, tool: ToolInfo | undefined) {
  const parameters = tool?.parameters;
  const fields = Value.Check(ParameterFields, parameters) ? parameters.properties : {};

  return Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [
        `arg_${key}`,
        Value.Check(FixedChoice, fields[key]) && Value.Check(ScalarArg, value) ? value : true,
      ]),
  );
}

function commandPrograms(command: string): string[] {
  const bare = command.split("<<")[0].replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "\0");

  const programs = bare.split(/[;&|\n()`]+/).flatMap((segment) => {
    const program = segment
      .trim()
      .split(/\s+/)
      .find((word) => !/^\w+=/.test(word));

    return program && /^[a-z_./][\w./+-]*$/i.test(program) ? [basename(program)] : [];
  });

  return [...new Set(programs)];
}

function usageDetails(toolName: string, args: ToolArgs) {
  if (toolName === "bash" && Value.Check(BashArgs, args))
    return { programs: commandPrograms(args.command) };

  if (toolName === "read" && Value.Check(ReadArgs, args) && basename(args.path) === "SKILL.md")
    return { skill: basename(dirname(args.path)) };

  return {};
}

function resultSize(content: Static<typeof ToolResult>["content"]) {
  return {
    result_chars: content.reduce(
      (chars, block) => chars + (block.type === "text" ? block.text.length : 0),
      0,
    ),
    result_images: content.filter((block) => block.type === "image").length,
  };
}

export default function (pi: ExtensionAPI) {
  const token = readToken();

  if (!token) return;

  const distinctId = userInfo().username;
  let queue: CapturedEvent[] = [];
  let traceId: string | undefined;
  let repo: string | undefined;
  let branch: string | undefined;
  let reportedFailure = false;
  let tools = new Map<string, ToolInfo>();
  let offeredKey: string | undefined;

  const startedCalls = new Map<string, { toolName: string; args: ToolArgs }>();

  const flush = async (ctx: ExtensionContext, timeoutMs: number) => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];

    const res = await fetch("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: token, batch }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined);

    if (res?.ok) return;

    if (!res || res.status === 429 || res.status >= 500) {
      queue = [...batch, ...queue].slice(-500);

      return;
    }

    if (reportedFailure || !ctx.hasUI) return;
    reportedFailure = true;
    ctx.ui.notify(
      `posthog: upload rejected: HTTP ${res.status} ${await res.text().catch(() => "")}`,
      "warning",
    );
  };

  const capture = (
    ctx: ExtensionContext,
    event: string,
    timestamp: number,
    properties: Record<string, PropertyValue>,
  ) => {
    queue.push({
      event,
      uuid: randomUUID(),
      timestamp: new Date(timestamp).toISOString(),
      properties: {
        distinct_id: distinctId,
        $process_person_profile: false,
        $ai_session_id: ctx.sessionManager.getSessionId(),
        $ai_trace_id: traceId ?? randomUUID(),
        repo,
        branch,
        subagent: process.env.PI_IS_SUBAGENT === "1",
        ...properties,
      },
    });

    if (queue.length >= 50) void flush(ctx, 15_000);
  };

  const captureSummary = (ctx: ExtensionContext, spanName: string, usage: Usage | undefined) => {
    if (!usage) return;
    capture(ctx, "$ai_generation", Date.now(), {
      $ai_span_name: spanName,
      $ai_model: ctx.model?.id,
      $ai_provider: ctx.model?.provider,
      ...usageProperties(usage),
    });
  };

  const captureOffered = (ctx: ExtensionContext) => {
    const allTools = pi.getAllTools().filter((tool) => tool.exposure !== "hidden");
    tools = new Map(allTools.map((tool) => [tool.name, tool]));
    const active = new Set(pi.getActiveTools());
    const key = JSON.stringify(allTools.map((tool) => [tool.name, active.has(tool.name)]));

    if (key === offeredKey) return;
    offeredKey = key;

    for (const tool of allTools)
      capture(ctx, "pi tool offered", Date.now(), {
        tool: tool.name,
        active: active.has(tool.name),
        exposure: tool.exposure,
        extension: extensionName(tool.sourceInfo),
        definition_chars: definitionChars(tool),
      });
  };

  pi.on("session_start", () => {
    offeredKey = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    traceId = randomUUID();
    captureOffered(ctx);

    const git = await pi.exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { cwd: ctx.cwd, timeout: 1000 },
    );

    const [commonDir, head] = git.stdout.trim().split("\n");
    repo = git.code === 0 && commonDir ? basename(dirname(commonDir)) : undefined;
    branch = git.code === 0 ? head : undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;

    if (message.role !== "assistant") return;
    capture(ctx, "$ai_generation", message.timestamp, {
      $ai_span_name: "turn",
      $ai_model: message.responseModel ?? message.model,
      $ai_provider: message.provider,
      $ai_latency: message.durationMs === undefined ? undefined : message.durationMs / 1000,
      $ai_stop_reason: message.stopReason,
      $ai_is_error: message.stopReason === "error",
      $ai_error: message.errorMessage,
      thinking_level: message.thinkingLevel,
      ...usageProperties(message.usage),
    });
  });

  pi.on("tool_execution_start", (event) => {
    startedCalls.set(event.toolCallId, {
      toolName: event.toolName,
      args: Value.Check(ToolArgs, event.args) ? event.args : {},
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const args = startedCalls.get(event.toolCallId)?.args ?? {};
    startedCalls.delete(event.toolCallId);
    capture(ctx, "pi tool call", Date.now(), {
      tool: event.toolName,
      duration_ms: event.durationMs,
      ran: event.durationMs !== undefined,
      is_error: event.isError,
      parent_tool:
        event.parentToolCallId === undefined
          ? undefined
          : startedCalls.get(event.parentToolCallId)?.toolName,
      $ai_model: ctx.model?.id,
      $ai_provider: ctx.model?.provider,
      thinking_level: pi.getThinkingLevel(),
      ...resultSize(Value.Check(ToolResult, event.result) ? event.result.content : []),
      ...argProperties(args, tools.get(event.toolName)),
      ...usageDetails(event.toolName, args),
    });
  });

  pi.on("session_compact", (event, ctx) =>
    captureSummary(ctx, "compaction", event.compactionEntry.usage),
  );

  pi.on("session_tree", (event, ctx) =>
    captureSummary(ctx, "branch_summary", event.summaryEntry?.usage),
  );

  pi.on("agent_settled", (_event, ctx) => {
    traceId = undefined;
    void flush(ctx, 15_000);
  });

  pi.on("session_shutdown", (_event, ctx) => flush(ctx, 3000));
}
