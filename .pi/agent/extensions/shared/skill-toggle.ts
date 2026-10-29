import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Skill directories, relative to the clone root. */
  skillPaths: string[];
  /** Directories to check out. Omit to check out the whole repository. */
  sparsePaths?: string[];
}

export interface SkillToggle {
  isEnabled: () => boolean;
  cloneDir: string;
}

export function registerSkillToggle(
  pi: ExtensionAPI,
  config: SkillToggleConfig,
): SkillToggle {
  const { name, label, repoUrl, cacheDirName, sparsePaths } = config;
  const cloneDir = join(homedir(), ".cache", cacheDirName);
  const skillDirs = config.skillPaths.map((p) => join(cloneDir, p));
  const isCloned = (): boolean => skillDirs.every((dir) => existsSync(dir));

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

  const sessionChoice = (
    entries: readonly { type: string }[],
  ): boolean | undefined => {
    let choice: boolean | undefined;
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      const custom = entry as { customType?: string; data?: unknown };
      if (custom.customType !== ENTRY_TYPE) continue;
      const data = custom.data as ToggleEntry | undefined;
      if (data?.name === name) choice = data.enabled === true;
    }
    return choice;
  };

  const repoDefaultFile = async (cwd: string): Promise<string | undefined> => {
    try {
      const commonDir = await git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
      );
      return join(commonDir, `pi-${name}`);
    } catch {
      return undefined;
    }
  };

  const ensureClone = async (): Promise<void> => {
    if (isCloned()) return;
    const partial = `${cloneDir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    await git([
      "clone",
      "--depth",
      "1",
      ...(sparsePaths ? ["--filter=blob:none", "--sparse"] : []),
      repoUrl,
      partial,
    ]);
    if (sparsePaths)
      await git(["sparse-checkout", "set", ...sparsePaths], partial);
    renameSync(partial, cloneDir);
  };

  const syncClone = async (): Promise<string> => {
    if (!isCloned()) {
      await ensureClone();
      return "cloned";
    }
    const before = await git(["rev-parse", "HEAD"], cloneDir);
    try {
      await git(["pull", "--ff-only"], cloneDir);
    } catch (err) {
      return `pull failed, using cached copy: ${(err as Error).message.split("\n")[0]}`;
    }
    return (await git(["rev-parse", "HEAD"], cloneDir)) === before
      ? "up to date"
      : "updated";
  };

  pi.on("resources_discover", async ({ cwd }) => {
    if (!isEnabled() || !isCloned()) return {};
    const agentDir = getAgentDir();
    const resolved = await new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    }).resolve(async () => "skip");
    const taken = new Set(
      loadSkills({
        cwd,
        agentDir,
        skillPaths: resolved.skills
          .filter((skill) => skill.enabled)
          .map((skill) => skill.path),
        includeDefaults: false,
      }).skills.map((skill) => skill.name),
    );
    const { skills } = loadSkills({
      cwd,
      agentDir,
      skillPaths: skillDirs,
      includeDefaults: false,
    });
    return {
      skillPaths: skills
        .filter((skill) => !taken.has(skill.name))
        .map((skill) => skill.baseDir),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const file = await repoDefaultFile(ctx.cwd);
    enabled =
      sessionChoice(ctx.sessionManager.getBranch()) ??
      (file !== undefined && existsSync(file));
    if (enabled && !isCloned()) {
      try {
        await ensureClone();
      } catch (e) {
        enabled = false;
        ctx.ui.notify(
          `${name} clone failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    }
    ctx.ui.setStatus(name, isEnabled() ? `${name}:on` : undefined);
  });

  const enable = async (ctx: ExtensionCommandContext): Promise<void> => {
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
  };

  const disable = async (ctx: ExtensionCommandContext): Promise<void> => {
    setEnabled(false);
    ctx.ui.notify(`${label} off — reloading`, "info");
    await ctx.reload();
  };

  pi.registerCommand(name, {
    description: `Flip ${label} on/off (off by default); /${name} repo flips this repository's default; /${name} update syncs the clone`,
    getArgumentCompletions: (prefix) => {
      const items = [
        {
          value: "repo",
          label: "repo",
          description: "Flip the default for this repository",
        },
        { value: "update", label: "update", description: "Sync the clone" },
      ].filter((item) => item.value.startsWith(prefix.trim()));
      return items.length ? items : null;
    },
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

      if (arg === "repo") {
        const file = await repoDefaultFile(ctx.cwd);
        if (!file) {
          ctx.ui.notify(`${name}: not inside a git repository`, "warning");
          return;
        }
        if (existsSync(file)) {
          rmSync(file);
          ctx.ui.notify(`${label}: off by default in this repository`, "info");
          if (isEnabled()) await disable(ctx);
          return;
        }
        writeFileSync(file, "");
        ctx.ui.notify(`${label}: on by default in this repository`, "info");
        if (!isEnabled()) await enable(ctx);
        return;
      }

      if (arg !== "") {
        ctx.ui.notify(
          `${name}: unknown arg '${arg}' (bare /${name} flips, or /${name} repo, or /${name} update)`,
          "warning",
        );
        return;
      }

      if (isEnabled()) await disable(ctx);
      else await enable(ctx);
    },
  });

  return { isEnabled, cloneDir };
}
