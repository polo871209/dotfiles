import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSkillToggle } from "./shared/skill-toggle.ts";

export default function (pi: ExtensionAPI) {
  registerSkillToggle(pi, {
    name: "lark",
    label: "Lark skills",
    repoUrl: "https://github.com/larksuite/cli",
    cacheDirName: "lark-skills",
    skillsSubdir: "skills",
  });

  registerSkillToggle(pi, {
    name: "gws",
    label: "GWS skills",
    repoUrl: "https://github.com/googleworkspace/cli",
    cacheDirName: "gws-skills",
    skillsSubdir: "skills",
  });
}
