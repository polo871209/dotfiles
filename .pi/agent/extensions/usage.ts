import {
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";

// The endpoint accepts only OAuth tokens. The registry returns the stored
// access token and refreshes it under pi's auth lock when it has expired.
async function oauthToken(
  ctx: ExtensionContext,
  provider: string,
): Promise<{ token: string } | string> {
  const cred = readStoredCredential(provider);
  if (!cred || cred.type !== "oauth") return "not logged in";
  // getProviderAuth, not getApiKeyForProvider: the latter swallows the
  // refresh error that tells the user what to do.
  let token: string | undefined;
  try {
    token = (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey;
  } catch (e) {
    return `token refresh failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!token) return "token refresh failed";
  return { token };
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

interface ClaudeBucket {
  utilization: number;
  resets_at: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeBucket | null;
  seven_day?: ClaudeBucket | null;
  seven_day_opus?: ClaudeBucket | null;
  seven_day_sonnet?: ClaudeBucket | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
  } | null;
}

const BAR_WIDTH = 20;
function bar(pct: number, theme: Theme): string {
  const filled = Math.round(
    (Math.min(100, Math.max(0, pct)) / 100) * BAR_WIDTH,
  );
  return (
    theme.fg("accent", "█".repeat(filled)) + "░".repeat(BAR_WIDTH - filled)
  );
}

function fmtLine(
  name: string,
  pct: number,
  resetsAt: Date | string,
  theme: Theme,
): string {
  const resetStr =
    resetsAt instanceof Date
      ? Number.isNaN(resetsAt.getTime())
        ? String(resetsAt)
        : resetsAt.toLocaleString()
      : resetsAt;
  const pctStr = `${pct.toFixed(0)}%`.padStart(4);
  return `${name}\n${bar(pct, theme)} ${pctStr} used  (resets ${resetStr})`;
}

async function claudeUsageLines(ctx: ExtensionContext): Promise<string[]> {
  const auth = await oauthToken(ctx, "anthropic");
  if (typeof auth === "string") return [auth];

  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "pi-coding-agent-usage-ext/0.1",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return [`request failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!res.ok) {
    return [
      `endpoint returned HTTP ${res.status} (undocumented API; may be rate-limited)`,
    ];
  }

  let data: ClaudeUsageResponse;
  try {
    data = (await res.json()) as ClaudeUsageResponse;
  } catch {
    return ["endpoint returned a body that is not JSON (undocumented API)"];
  }
  const bucket = (name: string, b: ClaudeBucket | null | undefined) =>
    b
      ? fmtLine(name, b.utilization, new Date(b.resets_at), ctx.ui.theme)
      : undefined;
  const lines = [
    bucket("5h session", data.five_hour),
    bucket("7d all-models", data.seven_day),
    bucket("7d Opus", data.seven_day_opus),
    bucket("7d Sonnet", data.seven_day_sonnet),
  ].filter((l): l is string => Boolean(l));

  if (data.extra_usage?.is_enabled) {
    const eu = data.extra_usage;
    lines.push(
      `Extra usage: $${eu.used_credits.toFixed(2)} / $${eu.monthly_limit.toFixed(2)} (${eu.utilization.toFixed(1)}%)`,
    );
  }

  return lines.length > 0 ? lines : ["no usage data returned"];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description:
      "Show Claude Pro/Max subscription usage (5h + weekly quotas)",
    handler: async (_args, ctx) => {
      const claude = await claudeUsageLines(ctx);
      ctx.ui.notify(`Claude\n${claude.join("\n")}`, "info");
    },
  });
}
