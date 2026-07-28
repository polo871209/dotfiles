// lark/gws — on-demand third-party skill packs, off by default.
//
// lark: Lark/Feishu skills (https://github.com/larksuite/cli). The repo
// ships ~27 skills (75k+ tokens of SKILL.md); always-on discovery would put
// 27 descriptions in every system prompt. /lark on registers them for this
// process (descriptions only — bodies still load lazily like any skill),
// /lark off deregisters. The source is a plain clone of the upstream repo in
// ~/.cache, so /lark update is just git pull.
//
// gws: Google Workspace skills (https://github.com/googleworkspace/cli). The
// repo ships 100+ skills; same off-by-default/on-demand treatment via /gws.
// The `gws` binary itself is installed separately (npm i -g
// @googleworkspace/cli; gws auth setup / gws auth login).
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
