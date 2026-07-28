// Shared factory for on-demand skill-pack toggles (used by skill-packs.ts): clone an
// upstream skills repo into ~/.cache, register it with pi only when enabled,
// and expose /<name> [update] to flip/sync it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const git = (args: string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });

export interface SkillToggleConfig {
  /** Command name, e.g. "lark" (registers /lark). */
  name: string;
  /** Human-readable label used in notifications, e.g. "Lark/Feishu skills". */
  label: string;
  repoUrl: string;
  /** Directory under ~/.cache to clone into. */
  cacheDirName: string;
  /** Subdirectory of the clone containing SKILL.md files. */
  skillsSubdir?: string;
}

export function registerSkillToggle(
  pi: ExtensionAPI,
  config: SkillToggleConfig,
): void {
  const { name, label, repoUrl, cacheDirName } = config;
  const cloneDir = join(homedir(), ".cache", cacheDirName);
  const skillsDir = config.skillsSubdir
    ? join(cloneDir, config.skillsSubdir)
    : cloneDir;

  // /reload re-runs this module with a fresh scope, and /<name> on|off itself
  // triggers ctx.reload() — the flag must survive that, so it lives on
  // globalThis instead of module state. Off on every fresh pi launch.
  const flag = `__${name}SkillsEnabled`;
  const isEnabled = (): boolean =>
    (globalThis as Record<string, unknown>)[flag] === true;
  const setEnabled = (v: boolean): void => {
    (globalThis as Record<string, unknown>)[flag] = v;
  };

  const ensureClone = async (): Promise<void> => {
    if (existsSync(skillsDir)) return;
    await git(["clone", "--depth", "1", repoUrl, cloneDir]);
  };

  // Clone if missing, else pull. Returns a human-readable outcome; a pull
  // failure (offline etc.) is non-fatal — the stale clone still works.
  const syncClone = async (): Promise<string> => {
    if (!existsSync(skillsDir)) {
      await ensureClone();
      return "cloned";
    }
    try {
      const out = await git(["pull", "--ff-only"], cloneDir);
      return out.includes("Already up to date") ? "up to date" : "updated";
    } catch {
      return "offline — using cached copy";
    }
  };

  pi.on("resources_discover", async () => {
    if (!isEnabled() || !existsSync(skillsDir)) return {};
    return { skillPaths: [skillsDir] };
  });

  pi.registerCommand(name, {
    description: `Flip ${label} on/off (off by default); /${name} update to sync the clone`,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "update") {
        ctx.ui.notify(`${label}: syncing…`, "info");
        try {
          const outcome = await syncClone();
          ctx.ui.notify(`${label}: ${outcome}`, "info");
        } catch (e) {
          ctx.ui.notify(
            `${name} update failed: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
          return;
        }
        if (isEnabled()) await ctx.reload();
        return;
      }

      if (arg !== "") {
        ctx.ui.notify(
          `${name}: unknown arg '${arg}' (bare /${name} flips, or /${name} update)`,
          "warning",
        );
        return;
      }

      // Bare /<name>: flip.
      if (isEnabled()) {
        setEnabled(false);
        ctx.ui.notify(`${label} off — reloading`, "info");
        await ctx.reload();
        return;
      }

      ctx.ui.notify(`${label}: syncing…`, "info");
      let outcome: string;
      try {
        outcome = await syncClone();
      } catch (e) {
        ctx.ui.notify(
          `${name} clone failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }
      setEnabled(true);
      ctx.ui.notify(`${label} on (${outcome}) — reloading`, "info");
      await ctx.reload();
    },
  });
}
