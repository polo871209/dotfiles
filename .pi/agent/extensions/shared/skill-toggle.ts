import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "./error";
import { customEntries } from "./session";

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

interface SkillToggle {
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
    entries: readonly SessionEntry[],
  ): boolean | undefined => {
    let choice: boolean | undefined;
    for (const entry of customEntries<ToggleEntry>(entries, ENTRY_TYPE)) {
      if (entry.data?.name === name) choice = entry.data.enabled === true;
    }
    return choice;
  };

  const folderDefaultsDir = join(getAgentDir(), "skill-packs", name);
  const folderDefaultFile = (folder: string): string =>
    join(folderDefaultsDir, encodeURIComponent(folder));
  const folderWithDefault = (cwd: string): string | undefined => {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      if (existsSync(folderDefaultFile(dir))) return dir;
      if (dirname(dir) === dir) return undefined;
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
      return `pull failed, using cached copy: ${errorMessage(err).split("\n")[0]}`;
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
    const requested = process.env.PI_SKILL_PACKS?.split(",").includes(name);
    if (process.env.PI_IS_SUBAGENT === "1") enabled = requested === true;
    else
      enabled =
        requested ||
        (sessionChoice(ctx.sessionManager.getBranch()) ??
          folderWithDefault(ctx.cwd) !== undefined);
    if (enabled && !isCloned()) {
      try {
        await ensureClone();
      } catch (e) {
        enabled = false;
        ctx.ui.notify(`${name} clone failed: ${errorMessage(e)}`, "error");
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
      ctx.ui.notify(`${name} clone failed: ${errorMessage(e)}`, "error");
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
    description: `Flip ${label} on/off (off by default); /${name} repo flips the default for this folder and its subfolders; /${name} update syncs the clone`,
    getArgumentCompletions: (prefix) => {
      const items = [
        {
          value: "repo",
          label: "repo",
          description: "Flip the default for this folder and its subfolders",
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
          ctx.ui.notify(`${name} update failed: ${errorMessage(e)}`, "error");
          return;
        }
        if (isEnabled()) await ctx.reload();
        return;
      }

      if (arg === "repo") {
        const folder = folderWithDefault(ctx.cwd);
        if (folder) {
          rmSync(folderDefaultFile(folder));
          ctx.ui.notify(`${label}: off by default in ${folder}`, "info");
          if (isEnabled()) await disable(ctx);
          return;
        }
        const cwd = resolve(ctx.cwd);
        mkdirSync(folderDefaultsDir, { recursive: true });
        writeFileSync(folderDefaultFile(cwd), "");
        ctx.ui.notify(`${label}: on by default in ${cwd}`, "info");
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
