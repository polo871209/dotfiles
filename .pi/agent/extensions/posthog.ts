import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface CapturedEvent {
  event: string;
  uuid: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

function readToken(): string | undefined {
  const path = join(getAgentDir(), "posthog.json");
  if (!existsSync(path)) return undefined;
  const { token } = JSON.parse(readFileSync(path, "utf8")) as {
    token?: unknown;
  };
  if (typeof token !== "string" || !token.startsWith("phc_"))
    throw new Error(`${path}: "token" must be a phc_ project token`);
  return token;
}

function usageProperties(usage: Usage): Record<string, unknown> {
  const { cost } = usage;
  return {
    // PostHog assumes cache-inclusive input for non-Anthropic providers, but pi-ai reports input without cache tokens for all of them.
    $ai_cache_reporting_exclusive: true,
    $ai_input_tokens: usage.input,
    $ai_output_tokens: usage.output,
    $ai_cache_read_input_tokens: usage.cacheRead,
    $ai_cache_creation_input_tokens: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined
      ? {}
      : {
          $ai_cache_creation_1h_input_tokens: usage.cacheWrite1h,
          $ai_cache_creation_5m_input_tokens:
            usage.cacheWrite - usage.cacheWrite1h,
        }),
    reasoning_tokens: usage.reasoning,
    ...(cost.total > 0
      ? {
          $ai_input_cost_usd: cost.input + cost.cacheRead + cost.cacheWrite,
          $ai_output_cost_usd: cost.output,
          $ai_total_cost_usd: cost.total,
        }
      : {}),
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

  const flush = async (ctx: ExtensionContext) => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    let failure: string;
    try {
      const res = await fetch("https://us.i.posthog.com/batch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: token, batch }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
      if (res.status === 429 || res.status >= 500) queue.unshift(...batch);
      failure = `HTTP ${res.status} ${await res.text()}`;
    } catch (e) {
      queue.unshift(...batch);
      failure = e instanceof Error ? e.message : String(e);
    }
    if (reportedFailure || !ctx.hasUI) return;
    reportedFailure = true;
    ctx.ui.notify(`posthog: upload failed: ${failure}`, "warning");
  };

  const capture = (
    ctx: ExtensionContext,
    event: string,
    timestamp: number,
    properties: Record<string, unknown>,
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
    if (queue.length >= 50) void flush(ctx);
  };

  const captureSummary = (
    ctx: ExtensionContext,
    spanName: string,
    usage: Usage | undefined,
  ) => {
    if (!usage) return;
    capture(ctx, "$ai_generation", Date.now(), {
      $ai_span_name: spanName,
      $ai_model: ctx.model?.id,
      $ai_provider: ctx.model?.provider,
      ...usageProperties(usage),
    });
  };

  pi.on("before_agent_start", async (_event, ctx) => {
    traceId = randomUUID();
    const git = await pi.exec(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--abbrev-ref",
        "HEAD",
      ],
      { cwd: ctx.cwd, timeout: 1000 },
    );
    const [commonDir, head] = git.stdout.trim().split("\n");
    repo =
      git.code === 0 && commonDir ? basename(dirname(commonDir)) : undefined;
    branch = git.code === 0 ? head : undefined;
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    capture(ctx, "$ai_generation", message.timestamp, {
      $ai_span_name: "turn",
      $ai_model: message.responseModel ?? message.model,
      $ai_provider: message.provider,
      $ai_latency:
        message.durationMs === undefined
          ? undefined
          : message.durationMs / 1000,
      $ai_stop_reason: message.stopReason,
      $ai_is_error: message.stopReason === "error",
      $ai_error: message.errorMessage,
      thinking_level: message.thinkingLevel,
      ...usageProperties(message.usage),
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    capture(ctx, "pi tool call", Date.now(), {
      tool: event.toolName,
      duration_ms: event.durationMs,
      is_error: event.isError,
      nested: event.parentToolCallId !== undefined,
    });
  });

  pi.on("session_compact", (event, ctx) =>
    captureSummary(ctx, "compaction", event.compactionEntry.usage),
  );

  pi.on("session_tree", (event, ctx) =>
    captureSummary(ctx, "branch_summary", event.summaryEntry?.usage),
  );

  pi.on("agent_settled", async (_event, ctx) => {
    traceId = undefined;
    await flush(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await flush(ctx);
  });
}
