// Customizes pi TUI: padding, input text color, and slim footer.
// Disable padding with PI_TUI_PADDING=0, or set a custom width (default: 5).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Editor,
  TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const PAD = Math.max(
  0,
  Number.parseInt(process.env.PI_TUI_PADDING ?? "5", 10) || 0,
);

const INPUT = "\x1b[38;2;205;214;244m";
const RESET = "\x1b[0m";
const BORDER = /^[\x1b\[[0-9;]*m]*[─ ↑↓0-9more]+[\x1b\[[0-9;]*m]*$/;

const colorInputLine = (line: string) => {
  if (BORDER.test(line)) return line;
  return `${INPUT}${line.replaceAll(RESET, `${RESET}${INPUT}`)}${RESET}`;
};

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

const installPaddingPatch = () => {
  const proto = TUI.prototype as unknown as {
    render(width: number): string[];
    __padded?: boolean;
  };

  if (PAD <= 0 || proto.__padded) return;

  proto.__padded = true;
  const origRender = proto.render;
  proto.render = function (width: number): string[] {
    const inner = Math.max(1, width - 2 * PAD);
    const lines = origRender.call(this, inner);
    const pad = " ".repeat(PAD);
    return lines.map((l: string) => pad + l);
  };
};

const installInputColorPatch = () => {
  const proto = Editor.prototype as unknown as {
    render(width: number): string[];
    __inputWhite?: boolean;
  };

  if (proto.__inputWhite) return;

  proto.__inputWhite = true;
  const origRender = proto.render;
  proto.render = function (width: number): string[] {
    return origRender.call(this, width).map(colorInputLine);
  };
};

const installFooter = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        let pwd = process.cwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName?.();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

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

        const modelName = ctx.model?.id ?? "no-model";
        let thinkingText = "";
        let thinkingKey: string | null = null;
        if (ctx.model?.reasoning) {
          const lvl = String((pi as any).getThinkingLevel?.() ?? "off");
          thinkingText = lvl === "off" ? "thinking off" : lvl;
          const cap = lvl.charAt(0).toUpperCase() + lvl.slice(1);
          thinkingKey = `thinking${cap}`;
        }
        const rightPlain = thinkingText
          ? `${modelName} • ${thinkingText}`
          : modelName;
        const rightColored = thinkingKey
          ? `${theme.fg("dim", `${modelName} • `)}${theme.fg(thinkingKey as never, thinkingText)}`
          : theme.fg("dim", modelName);

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

        return [line];
      },
    }));
  });
};

installPaddingPatch();
installInputColorPatch();

export default function (pi: ExtensionAPI) {
  installFooter(pi);
}
