import {
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerSkillToggle } from "../shared/skill-toggle.ts";

export default function (pi: ExtensionAPI) {
  const pstack = registerSkillToggle(pi, {
    name: "poteto",
    label: "Poteto mode",
    repoUrl: "https://github.com/cursor/plugins",
    cacheDirName: "cursor-plugins",
    skillPaths: [
      "pstack/skills",
      "cursor-team-kit/skills/deslop",
      "cursor-team-kit/skills/control-cli",
      "cursor-team-kit/skills/control-ui",
    ],
    sparsePaths: ["pstack", "cursor-team-kit/skills"],
  });
  const skillFile = join(pstack.cloneDir, "pstack/skills/poteto-mode/SKILL.md");
  const adapterFile = join(import.meta.dirname, "pi.md");

  pi.on("before_agent_start", (event) => {
    if (!pstack.isEnabled()) return;
    const { body } = parseFrontmatter(readFileSync(skillFile, "utf-8"));
    event.systemPromptOptions.sections["poteto-mode"] = [
      `Poteto mode is on for this session. Follow the skill below on every task. Its file is \`${skillFile}\`, so \`../<name>/SKILL.md\` resolves next to it.`,
      readFileSync(adapterFile, "utf-8").trim(),
      body.trim(),
    ].join("\n\n");
  });
}
