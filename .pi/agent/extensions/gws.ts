// gws — on-demand Google Workspace skills (https://github.com/googleworkspace/cli).
// The repo ships 100+ skills; always-on discovery would flood every system
// prompt. So: off by default, /gws on registers them for this process
// (descriptions only — bodies still load lazily like any skill), /gws off
// deregisters. The source is a plain clone of the upstream repo in ~/.cache,
// so /gws update is just git pull. The `gws` binary itself is installed
// separately (npm i -g @googleworkspace/cli; gws auth setup / gws auth login).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_URL = "https://github.com/googleworkspace/cli";
const CLONE_DIR = join(homedir(), ".cache", "gws-skills");
const SKILLS_DIR = join(CLONE_DIR, "skills");

// /reload re-runs this module with a fresh scope, and /gws on|off itself
// triggers ctx.reload() — the flag must survive that, so it lives on
// globalThis instead of module state. Off on every fresh pi launch.
const FLAG = "__gwsSkillsEnabled";
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

  pi.registerCommand("gws", {
    description:
      "Flip Google Workspace skills on/off (off by default); /gws update to sync the clone",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "update") {
        ctx.ui.notify("GWS skills: syncing…", "info");
        try {
          const outcome = await syncClone();
          ctx.ui.notify(`GWS skills: ${outcome}`, "info");
        } catch (e) {
          ctx.ui.notify(
            `gws update failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
          return;
        }
        if (isEnabled()) await ctx.reload();
        return;
      }

      if (arg !== "") {
        ctx.ui.notify(
          `gws: unknown arg '${arg}' (bare /gws flips, or /gws update)`,
          "warning",
        );
        return;
      }

      // Bare /gws: flip.
      if (isEnabled()) {
        setEnabled(false);
        ctx.ui.notify("GWS skills off — reloading", "info");
        await ctx.reload();
        return;
      }

      ctx.ui.notify("GWS skills: syncing…", "info");
      let outcome: string;
      try {
        outcome = await syncClone();
      } catch (e) {
        ctx.ui.notify(
          `gws clone failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }
      setEnabled(true);
      ctx.ui.notify(`GWS skills on (${outcome}) — reloading`, "info");
      await ctx.reload();
    },
  });
}
