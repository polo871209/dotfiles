import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Rule = { name: string; command: RegExp };

const SHELL_TOOLS = new Set(["bash", "quiet_run"]);

const RULES: Rule[] = [
  {
    name: "kill command",
    command: /(?:^|[\s;&|(`/])(?:kill|pkill|killall)(?=$|[\s;&|)`])/m,
  },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!SHELL_TOOLS.has(event.toolName)) return undefined;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;
    const rule = RULES.find((candidate) => candidate.command.test(command));
    if (!rule) return undefined;

    if (process.env.PI_IS_SUBAGENT === "1") {
      return {
        block: true,
        reason: `A ${rule.name} needs the user's approval, and a subagent cannot ask. Do not retry it in another form. Put the exact command in your final report so the parent agent can run it.`,
      };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `A ${rule.name} needs the user's approval, and this run has no UI.`,
      };
    }
    const approved = await ctx.ui.confirm(
      `Allow ${rule.name}?`,
      `${ctx.cwd}\n\n${command}`,
    );
    return approved
      ? undefined
      : { block: true, reason: `The user rejected this ${rule.name}.` };
  });
}
