import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "./error";
import { run } from "./exec";
import { customEntries } from "./session";

interface Subcommand {
  description: string;
  run: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface ToggleConfig {
  name: string;
  label: string;
  prepare?: (trigger: "start" | "command") => Promise<string | void>;
  onStart?: (enabled: boolean, ctx: ExtensionContext) => void;
  onChange: (enabled: boolean, ctx: ExtensionCommandContext) => Promise<void>;
  subcommands?: Record<string, Subcommand>;
}

export interface Toggle {
  isEnabled: () => boolean;
}

const ENTRY_TYPE = "toggle";

const repoRoot = async (cwd: string): Promise<string | undefined> => {
  const result = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    undefined,
    cwd,
    5_000,
  );
  return result.code === 0 ? dirname(result.stdout.trim()) : undefined;
};

interface ToggleEntry {
  name: string;
  enabled: boolean;
}

export function registerToggle(pi: ExtensionAPI, config: ToggleConfig): Toggle {
  const { name, label, prepare, onStart, onChange } = config;
  let enabled = false;

  const folderDefaultsDir = join(getAgentDir(), "toggles", name);
  const folderDefaultFile = (folder: string): string =>
    join(folderDefaultsDir, encodeURIComponent(folder));
  const defaultAbove = (start: string): string | undefined => {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(folderDefaultFile(dir))) return dir;
      if (dirname(dir) === dir) return undefined;
    }
  };
  const folderWithDefault = async (cwd: string): Promise<string | undefined> =>
    defaultAbove(resolve(cwd)) ??
    (await repoRoot(cwd).then((root) => root && defaultAbove(root)));

  const showStatus = (ctx: ExtensionContext): void =>
    ctx.ui.setStatus(name, enabled ? `${name}:on` : undefined);

  const setEnabled = async (
    value: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    let note: string | void = undefined;
    if (value && prepare) {
      ctx.ui.notify(`${label}: preparing…`, "info");
      try {
        note = await prepare("command");
      } catch (e) {
        ctx.ui.notify(`${label} failed: ${errorMessage(e)}`, "error");
        return;
      }
    }
    enabled = value;
    pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { name, enabled });
    ctx.ui.notify(
      `${label} ${enabled ? "on" : "off"}${note ? ` (${note})` : ""}`,
      "info",
    );
    showStatus(ctx);
    await onChange(enabled, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    const requested =
      process.env.PI_SKILL_PACKS?.split(",").includes(name) === true;
    const sessionChoice = customEntries<ToggleEntry>(
      ctx.sessionManager.getBranch(),
      ENTRY_TYPE,
    )
      .filter((entry) => entry.data?.name === name)
      .at(-1)?.data?.enabled;
    enabled =
      process.env.PI_IS_SUBAGENT === "1"
        ? requested
        : requested ||
          (sessionChoice ?? (await folderWithDefault(ctx.cwd)) !== undefined);
    if (enabled) {
      try {
        await prepare?.("start");
      } catch (e) {
        enabled = false;
        ctx.ui.notify(`${label} failed: ${errorMessage(e)}`, "error");
      }
    }
    showStatus(ctx);
    onStart?.(enabled, ctx);
  });

  const subcommands: Record<string, Subcommand> = {
    repo: {
      description:
        "Flip the default for this repository with all its worktrees, or for this folder outside a repository",
      run: async (ctx) => {
        const folder = await folderWithDefault(ctx.cwd);
        if (folder) {
          rmSync(folderDefaultFile(folder));
          ctx.ui.notify(`${label}: off by default in ${folder}`, "info");
          if (enabled) await setEnabled(false, ctx);
          return;
        }
        const scope = (await repoRoot(ctx.cwd)) ?? resolve(ctx.cwd);
        mkdirSync(folderDefaultsDir, { recursive: true });
        writeFileSync(folderDefaultFile(scope), "");
        ctx.ui.notify(`${label}: on by default in ${scope}`, "info");
        if (!enabled) await setEnabled(true, ctx);
      },
    },
    ...config.subcommands,
  };

  pi.registerCommand(name, {
    description: [
      `Flip ${label} for this session`,
      ...Object.entries(subcommands).map(
        ([arg, { description }]) => `/${name} ${arg}: ${description}`,
      ),
    ].join("; "),
    getArgumentCompletions: (prefix) => {
      const items = Object.entries(subcommands)
        .filter(([arg]) => arg.startsWith(prefix.trim()))
        .map(([arg, { description }]) => ({
          value: arg,
          label: arg,
          description,
        }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "") return setEnabled(!enabled, ctx);
      const subcommand = subcommands[arg];
      if (subcommand) return subcommand.run(ctx);
      const usage = ["", ...Object.keys(subcommands)]
        .map((key) => `/${name} ${key}`.trim())
        .join(", ");
      ctx.ui.notify(
        `${name}: unknown argument '${arg}'. Use ${usage}.`,
        "warning",
      );
    },
  });

  return { isEnabled: () => enabled };
}
