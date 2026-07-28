// /usage — show Claude Pro/Max and Codex/ChatGPT subscription usage
// (5h/session + weekly quotas) for whichever of the two are logged in.
//
// Both endpoints are undocumented. Both read OAuth creds pi already stores
// ("anthropic", "openai-codex") — not API keys, and not the standalone
// `codex` CLI's separate `~/.codex/auth.json`.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  readStoredCredential,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// Providers may rotate refresh tokens on use; without writing the new pair
// back, the on-disk refresh token pi shares would be invalidated. Same file
// and mode as pi's FileAuthStorageBackend, and the same mutual exclusion:
// pi locks via proper-lockfile, which is `mkdir <file>.lock` under the hood
// (that package isn't importable from here — not a direct dependency).
function persistRefreshedTokens(
  providerId: string,
  tokens: { access: string; refresh: string; expires: number },
): void {
  const authPath = path.join(getAgentDir(), "auth.json");
  const lockDir = `${authPath}.lock`;
  let locked = false;
  try {
    for (let attempt = 0; attempt < 5 && !locked; attempt++) {
      try {
        fs.mkdirSync(lockDir);
        locked = true;
      } catch {
        const start = Date.now();
        while (Date.now() - start < 20) {
          /* brief sync backoff, mirrors pi's own retry */
        }
      }
    }
    if (!locked) return; // pi holds the lock; skip — costs one extra refresh
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const cur = data[providerId];
    if (!cur || cur.type !== "oauth") return;
    data[providerId] = { ...cur, ...tokens };
    fs.writeFileSync(authPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Best effort: a failed persist only costs an extra refresh later.
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        /* ignore */
      }
    }
  }
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

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

async function refreshClaudeAccessToken(
  refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLAUDE_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
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

async function claudeUsageLines(): Promise<string[]> {
  const cred = readStoredCredential("anthropic");
  if (!cred || cred.type !== "oauth" || !cred.access) {
    return ["not logged in"];
  }

  let access = cred.access;
  if (cred.expires && cred.expires < Date.now() && cred.refresh) {
    try {
      const tokens = await refreshClaudeAccessToken(cred.refresh);
      access = tokens.access;
      persistRefreshedTokens("anthropic", tokens);
    } catch (e) {
      return [
        `token refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      ];
    }
  }

  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${access}`,
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
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

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

async function refreshCodexAccessToken(
  refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!data.access_token)
    throw new Error("Token refresh returned no access token");
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? refreshToken,
    // Codex access tokens are hour-scale JWTs; a conservative fixed window
    // avoids decoding the token just to recover exp.
    expires: Date.now() + 30 * 60 * 1000,
  };
}

async function codexUsageLines(): Promise<string[]> {
  const cred = readStoredCredential("openai-codex");
  if (!cred || cred.type !== "oauth" || !cred.access) {
    return ["not logged in"];
  }

  let access = cred.access;
  if (cred.expires && cred.expires < Date.now() && cred.refresh) {
    try {
      const tokens = await refreshCodexAccessToken(cred.refresh);
      access = tokens.access;
      persistRefreshedTokens("openai-codex", tokens);
    } catch (e) {
      return [
        `token refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      ];
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    "User-Agent": "pi-coding-agent-usage-ext/0.1",
  };
  if (typeof cred.accountId === "string") {
    headers["ChatGPT-Account-Id"] = cred.accountId;
  }

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
        claudeUsageLines(),
        codexUsageLines(),
      ]);

      const sections = [
        `Claude\n${claude.join("\n")}`,
        `Codex\n${codex.join("\n")}`,
      ];
      ctx.ui.notify(sections.join("\n\n"), "info");
    },
  });
}
