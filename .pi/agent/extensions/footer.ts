// footer — replaces pi's built-in footer with a single-line slim version.
//
// Default footer is two lines:
//   line 1: ~/path (branch) • session-name
//   line 2: ↑in ↓out Rcache Wcache $cost (sub) ctx%/window (auto)   model • thinking
//
// This extension drops the four token stats (↑↓RW) and merges everything
// onto ONE line:
//   ~/path (branch) • session-name   $cost (sub) ctx%/window           model
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const fmtTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

const sumCost = (ctx: any): number => {
  let cost = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      cost += m.usage?.cost?.total ?? 0;
    }
  }
  return cost;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        // pwd + (branch) + session name
        let pwd = process.cwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName?.();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        // cost + context %
        const cost = sumCost(ctx);
        const usingSub = ctx.model
          ? ctx.modelRegistry.isUsingOAuth?.(ctx.model) === true
          : false;
        const usage = ctx.getContextUsage?.();
        const stats: string[] = [];
        if (cost > 0 || usingSub) {
          stats.push(`$${cost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
        }
        if (usage) {
          const pct =
            usage.percent != null ? `${usage.percent.toFixed(1)}%` : "?";
          stats.push(`${pct}/${fmtTokens(usage.contextWindow)}`);
        }
        const left = [pwd, stats.join(" ")].filter(Boolean).join("   ");

        // model + thinking (thinking-level text gets its own theme color so
        // it's visually distinct from dim pwd/stats/model)
        const modelName = ctx.model?.id ?? "no-model";
        let thinkingText = "";
        let thinkingKey: string | null = null;
        if (ctx.model?.reasoning) {
          const lvl = String((pi as any).getThinkingLevel?.() ?? "off");
          thinkingText = lvl === "off" ? "thinking off" : lvl;
          // map level -> theme color key (thinkingOff/Minimal/Low/Medium/High/Xhigh)
          const cap = lvl.charAt(0).toUpperCase() + lvl.slice(1);
          thinkingKey = `thinking${cap}`;
        }
        const rightPlain = thinkingText
          ? `${modelName} • ${thinkingText}`
          : modelName;
        const rightColored = thinkingKey
          ? `${theme.fg("dim", `${modelName} • `)}${theme.fg(thinkingKey as never, thinkingText)}`
          : theme.fg("dim", modelName);

        // One line: left  …pad…  right (measure with rightPlain so visibleWidth
        // ignores the per-segment ANSI codes in rightColored)
        const dimLeft = theme.fg("dim", left);
        const lw = visibleWidth(left);
        const rw = visibleWidth(rightPlain);
        let line: string;
        if (lw + 2 + rw <= width) {
          line = dimLeft + " ".repeat(width - lw - rw) + rightColored;
        } else if (lw < width) {
          const avail = width - lw - 2;
          const truncR =
            avail > 0 ? truncateToWidth(rightPlain, avail, "") : "";
          const truncRw = visibleWidth(truncR);
          line =
            dimLeft +
            " ".repeat(Math.max(0, width - lw - truncRw)) +
            theme.fg("dim", truncR);
        } else {
          line = theme.fg("dim", truncateToWidth(left, width, "..."));
        }

        // Extension statuses (e.g. "◆ 24 checkpoints" from pi-rewind) are
        // intentionally suppressed — the footer stays a single line.
        return [line];
      },
    }));
  });
}
