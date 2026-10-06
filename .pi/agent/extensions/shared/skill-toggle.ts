// Shared factory for on-demand skill-pack toggles (used by skill-packs.ts): clone an
// upstream skills repo into ~/.cache, register it with pi only when enabled,
// and expose /<name> [update] to flip/sync it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const git = (args: string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    // No credential prompt: git would draw it on /dev/tty, over the TUI.
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      },
    );
  });

interface SkillToggleConfig {
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

  // The flag cannot live in module state, because /reload re-runs this module
  // and /<name> on|off itself calls ctx.reload(). It lives in the session as a
  // custom entry. Reload keeps the SessionManager, so the entry survives, as
  // does a later /resume. A new session has no entry and starts off. Custom
  // entries never reach the LLM.
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

  // Clone beside the target and rename, so a killed clone never leaves a
  // half-filled cloneDir that blocks the next clone.
  const ensureClone = async (): Promise<void> => {
    if (existsSync(skillsDir)) return;
    const partial = `${cloneDir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    await git(["clone", "--depth", "1", repoUrl, partial]);
    renameSync(partial, cloneDir);
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

  // Publish state through the footer-status channel (reset on every reload), so
  // extensions need not reach into each other's state.
  // getBranch(): a toggle recorded on a branch that /tree left does not count.
  pi.on("session_start", async (_event, ctx) => {
    restoreEnabled(ctx.sessionManager.getBranch());
    ctx.ui.setStatus(name, isEnabled() ? `${name}:on` : undefined);
  });

  pi.registerCommand(name, {
    description: `Flip ${label} on/off (off by default); /${name} update to sync the clone`,
    getArgumentCompletions: (prefix) =>
      "update".startsWith(prefix.trim())
        ? [{ value: "update", label: "update", description: "Sync the clone" }]
        : null,
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
