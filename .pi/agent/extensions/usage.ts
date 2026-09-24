// /usage — show Claude Pro/Max and Codex/ChatGPT subscription usage
// (5h/session + weekly quotas) for whichever of the two are logged in.
//
// Both endpoints are undocumented. Both read OAuth creds pi already stores
// ("anthropic", "openai-codex") — not API keys, and not the standalone
// `codex` CLI's separate `~/.codex/auth.json`.
import {
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Both endpoints accept only OAuth tokens. The registry returns the stored
// access token and refreshes it under pi's auth lock when it has expired.
async function oauthToken(
  ctx: ExtensionContext,
  provider: string,
): Promise<{ token: string; accountId?: string } | string> {
  const cred = readStoredCredential(provider);
  if (!cred || cred.type !== "oauth") return "not logged in";
  const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
  if (!token) return "token refresh failed";
  return {
    token,
    ...(typeof cred.accountId === "string"
      ? { accountId: cred.accountId }
      : {}),
  };
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
const BAR_FG = "\x1b[38;2;137;180;250m"; // catppuccin-mocha "blue" (#89b4fa)
const RESET_SGR = "\x1b[0m";

function bar(pct: number): string {
  const filled = Math.round(
    (Math.min(100, Math.max(0, pct)) / 100) * BAR_WIDTH,
  );
  return (
    BAR_FG + "█".repeat(filled) + RESET_SGR + "░".repeat(BAR_WIDTH - filled)
  );
}

function fmtLine(name: string, pct: number, resetsAt: Date | string): string {
  const resetStr =
    resetsAt instanceof Date
      ? Number.isNaN(resetsAt.getTime())
        ? String(resetsAt)
        : resetsAt.toLocaleString()
      : resetsAt;
  const pctStr = `${pct.toFixed(0)}%`.padStart(4);
  return `${name}\n${bar(pct)} ${pctStr} used  (resets ${resetStr})`;
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
    });
  } catch (e) {
    return [`request failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!res.ok) {
    return [
      `endpoint returned HTTP ${res.status} (undocumented API; may be rate-limited)`,
    ];
  }

  const data = (await res.json()) as ClaudeUsageResponse;
  const bucket = (name: string, b: ClaudeBucket | null | undefined) =>
    b ? fmtLine(name, b.utilization, new Date(b.resets_at)) : undefined;
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

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexRateLimitWindow {
  used_percent: number;
  reset_at: number;
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexRateLimitWindow | null;
    secondary_window?: CodexRateLimitWindow | null;
  } | null;
}

async function codexUsageLines(ctx: ExtensionContext): Promise<string[]> {
  const auth = await oauthToken(ctx, "openai-codex");
  if (typeof auth === "string") return [auth];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "User-Agent": "pi-coding-agent-usage-ext/0.1",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  let res: Response;
  try {
    res = await fetch(CODEX_USAGE_URL, { headers });
  } catch (e) {
    return [`request failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!res.ok) {
    return [
      `endpoint returned HTTP ${res.status} (undocumented API; may be rate-limited)`,
    ];
  }

  const data = (await res.json()) as CodexUsageResponse;
  const window = (name: string, w: CodexRateLimitWindow | null | undefined) =>
    w ? fmtLine(name, w.used_percent, new Date(w.reset_at * 1000)) : undefined;

  const lines = [
    window("primary", data.rate_limit?.primary_window),
    window("secondary", data.rate_limit?.secondary_window),
  ].filter((l): l is string => Boolean(l));

  return lines.length > 0 ? lines : ["no usage data returned"];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description:
      "Show Claude Pro/Max and Codex/ChatGPT subscription usage (5h + weekly quotas)",
    handler: async (_args, ctx) => {
      const [claude, codex] = await Promise.all([
        claudeUsageLines(ctx),
        codexUsageLines(ctx),
      ]);

      const sections = [
        `Claude\n${claude.join("\n")}`,
        `Codex\n${codex.join("\n")}`,
      ];
      ctx.ui.notify(sections.join("\n\n"), "info");
    },
  });
}
