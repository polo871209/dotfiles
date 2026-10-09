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
  name: string;
  label: string;
  repoUrl: string;
  cacheDirName: string;
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
    const partial = `${cloneDir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    await git(["clone", "--depth", "1", repoUrl, partial]);
    renameSync(partial, cloneDir);
  };

  const syncClone = async (): Promise<string> => {
    if (!existsSync(skillsDir)) {
      await ensureClone();
      return "cloned";
    }
    try {
      return (await git(["pull", "--ff-only"], cloneDir)).includes(
        "Already up to date",
      )
        ? "up to date"
        : "updated";
    } catch {
      return "offline — using cached copy";
    }
  };

  pi.on("resources_discover", async () => {
    if (!isEnabled() || !existsSync(skillsDir)) return {};
    return { skillPaths: [skillsDir] };
  });

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
          ctx.ui.notify(`${label}: ${await syncClone()}`, "info");
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
