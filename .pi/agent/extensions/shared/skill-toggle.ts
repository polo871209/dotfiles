import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "./error";
import { registerToggle, type Toggle } from "./toggle";

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
  skillPaths: string[];
  sparsePaths?: string[];
}

interface SkillToggle extends Toggle {
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

  const clone = async (): Promise<void> => {
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
      await clone();
      return "cloned";
    }
    const before = await git(["rev-parse", "HEAD"], cloneDir);
    try {
      await git(["pull", "--ff-only"], cloneDir);
    } catch (err) {
      return `pull failed, using cached copy: ${errorMessage(err).split("\n")[0]}`;
    }
    return (await git(["rev-parse", "HEAD"], cloneDir)) === before
      ? "up to date"
      : "updated";
  };

  const toggle = registerToggle(pi, {
    name,
    label,
    prepare: async (trigger) => {
      if (trigger === "command") return syncClone();
      if (!isCloned()) await clone();
    },
    onChange: (_enabled, ctx) => ctx.reload(),
    subcommands: {
      update: {
        description: "Sync the clone",
        run: async (ctx) => {
          ctx.ui.notify(`${label}: syncing…`, "info");
          try {
            ctx.ui.notify(`${label}: ${await syncClone()}`, "info");
          } catch (e) {
            ctx.ui.notify(
              `${label} update failed: ${errorMessage(e)}`,
              "error",
            );
            return;
          }
          if (toggle.isEnabled()) await ctx.reload();
        },
      },
    },
  });

  pi.on("resources_discover", async ({ cwd }) => {
    if (!toggle.isEnabled() || !isCloned()) return {};
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

  return { ...toggle, cloneDir };
}
