// lark — on-demand Lark/Feishu skills (https://github.com/larksuite/cli).
// The repo ships ~27 skills (75k+ tokens of SKILL.md); always-on discovery
// would put 27 descriptions in every system prompt. So: off by default,
// /lark on registers them for this process (descriptions only — bodies still
// load lazily like any skill), /lark off deregisters. The source is a plain
// clone of the upstream repo in ~/.cache, so /lark update is just git pull.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_URL = "https://github.com/larksuite/cli";
const CLONE_DIR = join(homedir(), ".cache", "lark-skills");
const SKILLS_DIR = join(CLONE_DIR, "skills");

// /reload re-runs this module with a fresh scope, and /lark on|off itself
// triggers ctx.reload() — the flag must survive that, so it lives on
// globalThis instead of module state. Off on every fresh pi launch.
const FLAG = "__larkSkillsEnabled";
const isEnabled = (): boolean =>
  (globalThis as Record<string, unknown>)[FLAG] === true;
const setEnabled = (v: boolean): void => {
  (globalThis as Record<string, unknown>)[FLAG] = v;
};

const git = (args: string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });

const ensureClone = async (): Promise<void> => {
  if (existsSync(SKILLS_DIR)) return;
  await git(["clone", "--depth", "1", REPO_URL, CLONE_DIR]);
};

// Clone if missing, else pull. Returns a human-readable outcome; a pull
// failure (offline etc.) is non-fatal — the stale clone still works.
const syncClone = async (): Promise<string> => {
  if (!existsSync(SKILLS_DIR)) {
    await ensureClone();
    return "cloned";
  }
  try {
    const out = await git(["pull", "--ff-only"], CLONE_DIR);
    return out.includes("Already up to date") ? "up to date" : "updated";
  } catch {
    return "offline — using cached copy";
  }
};

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async () => {
    if (!isEnabled() || !existsSync(SKILLS_DIR)) return {};
    return { skillPaths: [SKILLS_DIR] };
  });

  pi.registerCommand("lark", {
    description:
      "Flip Lark/Feishu skills on/off (off by default); /lark update to sync the clone",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "update") {
        ctx.ui.notify("Lark skills: syncing…", "info");
        try {
          const outcome = await syncClone();
          ctx.ui.notify(`Lark skills: ${outcome}`, "info");
        } catch (e) {
          ctx.ui.notify(
            `lark update failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
          return;
        }
        if (isEnabled()) await ctx.reload();
        return;
      }

      if (arg !== "") {
        ctx.ui.notify(
          `lark: unknown arg '${arg}' (bare /lark flips, or /lark update)`,
          "warning",
        );
        return;
      }

      // Bare /lark: flip.
      if (isEnabled()) {
        setEnabled(false);
        ctx.ui.notify("Lark skills off — reloading", "info");
        await ctx.reload();
        return;
      }

      ctx.ui.notify("Lark skills: syncing…", "info");
      let outcome: string;
      try {
        outcome = await syncClone();
      } catch (e) {
        ctx.ui.notify(
          `lark clone failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }
      setEnabled(true);
      ctx.ui.notify(`Lark skills on (${outcome}) — reloading`, "info");
      await ctx.reload();
    },
  });
}
