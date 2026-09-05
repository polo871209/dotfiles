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
  // triggers ctx.reload(), so the flag cannot live in module state. It lives
  // in the session as a custom entry: reload keeps the same SessionManager, so
  // the entry survives, and so does a later /resume of the same session. A new
  // session has no entry and therefore starts off.
  //
  // Custom entries never reach the LLM, so this costs no context.
  const ENTRY_TYPE = "skill-pack-toggle";
  interface ToggleEntry {
    name: string;
    enabled: boolean;
  }

  let enabled = false;
  const isEnabled = (): boolean => enabled;
  const setEnabled = (v: boolean): void => {
    enabled = v;
    pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { name, enabled: v });
  };

  // Last write wins. Read before resources_discover, which pi emits after
  // session_start on both startup and reload.
  const restoreEnabled = (entries: readonly { type: string }[]): void => {
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      const custom = entry as { customType?: string; data?: unknown };
      if (custom.customType !== ENTRY_TYPE) continue;
      const data = custom.data as ToggleEntry | undefined;
      if (data?.name === name) enabled = data.enabled === true;
    }
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

  // Publish on/off state through the built-in footer-status channel (reset
  // on every reload) instead of extensions reaching into each other's
  // internal state.
  pi.on("session_start", async (_event, ctx) => {
    restoreEnabled(ctx.sessionManager.getEntries());
    ctx.ui.setStatus(name, isEnabled() ? `${name}:on` : undefined);
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
