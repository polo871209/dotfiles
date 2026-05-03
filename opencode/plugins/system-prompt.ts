// Replaces default system prompt with prompt.txt + env + per-project AGENTS.md
// prompt.txt built from:
//   - https://github.com/JuliusBrussee/caveman
//   - https://github.com/forrestchang/andrej-karpathy-skills
import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";

export const SystemPromptPlugin: Plugin = async () => {
  const shortPrompt = readFileSync(
    new URL("./prompt.txt", import.meta.url),
    "utf8",
  ).trim();

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      // Find the entry with the base prompt (contains env, AGENTS.md, etc)
      const idx = output.system.findIndex((s) => s.includes("<env>"));
      if (idx === -1) return;

      const original = output.system[idx];

      // Keep env block
      const envMatch = original.match(/<env>[\s\S]*?<\/env>/);
      const envBlock = envMatch
        ? "Environment context you are running in:\n" + envMatch[0]
        : "";

      // Keep AGENTS.md instructions (format: "Instructions from: ...")
      const agentsMatch = original.match(/Instructions from:[\s\S]*$/);
      const agentsBlock = agentsMatch ? agentsMatch[0] : "";

      const next = [shortPrompt, envBlock, agentsBlock]
        .filter(Boolean)
        .join("\n\n");

      // Replace entire system array
      output.system.splice(0, output.system.length, next);
    },
  };
};

export default SystemPromptPlugin;
