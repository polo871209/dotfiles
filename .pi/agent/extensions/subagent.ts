// /subagent — delegate work to an isolated `pi` running as a real interactive
// agent inside its own herdr pane. Single-layer only: agents cannot spawn
// other subagents (PI_IS_SUBAGENT=1 in the child env makes this extension
// early-exit before registering its tool). Herdr-only: outside herdr there is
// no pane to run the child in, so the tool is not registered at all.
//
// Agents live in pi's standard agents dir (`~/.pi/agent/agents/*.md`) as
// markdown with YAML frontmatter:
//   ---
//   name: scout
//   description: ...
//   tools: read, grep, find, ls       # optional --tools allowlist
//   model: anthropic/claude-haiku-4-5  # optional
//   thinking: low                      # optional
//   maxDuration: 600                   # optional, seconds (wall-clock cap)
//   ---
//   <system prompt body>
//
// Status comes from herdr's own pi integration (herdr-agent-state.ts loads
// inside the child pane too, reporting working/blocked/idle for it same as
// any other pi session) instead of a parsed JSON event stream.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  getAgentDir,
  getMarkdownTheme,
  keyText,
  parseFrontmatter,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: string;
  maxDurationMs?: number;
  systemPrompt: string;
}

interface Progress {
  agent: string;
  task: string;
  model: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  durationMs: number;
  lastMessage: string;
  output: string;
  error?: string;
}

const AGENTS_DIR = path.join(getAgentDir(), "agents");
const MAX_OUTPUT_BYTES = 32 * 1024;
const UPDATE_INTERVAL_MS = 150;
const TASK_PREVIEW_MAX = 140;
const FORBIDDEN_TOOLS = new Set(["subagent"]);
const DEFAULT_MAX_DURATION_MS = 600_000;
// Tight enough to reliably beat herdr's default 1s notification delay when we
// release the pane's agent report right after detecting completion (see
// releaseNotification below).
const HERDR_POLL_MS = 300;

const execFileAsync = promisify(execFile);

function herdrActive(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

async function herdrJson<T>(args: string[]): Promise<T | undefined> {
  try {
    const { stdout } = await execFileAsync("herdr", args, {
      timeout: 10_000,
    });
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

async function herdrRun(args: string[]): Promise<boolean> {
  try {
    await execFileAsync("herdr", args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// `pane read` prints plain text, not JSON (unlike every other herdr
// subcommand) — must not go through herdrJson's JSON.parse.
async function herdrText(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("herdr", args, {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared herdr panel: concurrent subagents stack inside one fixed-width
// column (30% of the main pane) instead of each carving its own slice out of
// the main pane. The first subagent splits the main pane; later concurrent
// ones split the previous subagent's pane downward, so the panel's total
// width never grows with agent count. A simple promise chain serializes the
// split/close calls that mutate the shared panel list so concurrent
// executions can't race each other's layout changes.
const PANEL_WIDTH_RATIO = 0.7; // main pane keeps 70%, panel column gets 30%
let panel: string[] = [];
let panelChain: Promise<unknown> = Promise.resolve();

function withPanelLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = panelChain.then(fn, fn);
  panelChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function acquirePanelSlot(
  cwd: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  return withPanelLock(async () => {
    const envArgs = Object.entries(env).flatMap(([k, v]) => [
      "--env",
      `${k}=${v}`,
    ]);
    const anchor = panel.at(-1);
    const resp = anchor
      ? await herdrJson<Record<string, any>>([
          "pane",
          "split",
          anchor,
          "--direction",
          "down",
          "--ratio",
          "0.5",
          "--cwd",
          cwd,
          "--no-focus",
          ...envArgs,
        ])
      : await herdrJson<Record<string, any>>([
          "pane",
          "split",
          process.env.HERDR_PANE_ID!,
          "--direction",
          "right",
          "--ratio",
          String(PANEL_WIDTH_RATIO),
          "--cwd",
          cwd,
          "--no-focus",
          ...envArgs,
        ]);
    const paneId: string | undefined = resp?.result?.pane?.pane_id;
    if (paneId) panel.push(paneId);
    return paneId;
  });
}

async function releasePanelSlot(paneId: string): Promise<void> {
  await withPanelLock(async () => {
    await herdrRun(["pane", "close", paneId]);
    panel = panel.filter((id) => id !== paneId);
  });
}

function expandToolPatterns(patterns: string[], allNames: string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    if (!p.includes("*")) {
      if (!FORBIDDEN_TOOLS.has(p)) out.add(p);
      continue;
    }
    const re = new RegExp(
      "^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    for (const n of allNames) {
      if (FORBIDDEN_TOOLS.has(n)) continue;
      if (re.test(n)) out.add(n);
    }
  }
  return [...out];
}

function loadAgents(): AgentConfig[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const out: AgentConfig[] = [];
  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(AGENTS_DIR, entry), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = (frontmatter.tools || "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const secsToMs = (v: string | undefined): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
    };
    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      model: frontmatter.model || undefined,
      thinking: frontmatter.thinking || undefined,
      maxDurationMs: secsToMs(frontmatter.maxDuration),
      // Only the agent's own .md content — no shared preamble (SYSTEM.md is
      // the main session's own prompt, not a subagent default) and no other
      // injected context, so every subagent starts from a clean, unambiguous
      // slate defined entirely by its own file.
      systemPrompt: body.trim(),
    });
  }
  return out;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
};

const headTruncate = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf-8") + "\n…(truncated)";
};

// Preserves ANSI escapes so colored rows truncate without leaking codes.
const fitLine = (text: string, maxWidth: number): string => {
  const flat = text.includes("\n") ? text.replace(/\r?\n/g, " ") : text;
  if (visibleWidth(flat) <= maxWidth) return flat;
  let out = "";
  let w = 0;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === "\x1b") {
      const m = flat.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (w >= maxWidth - 1) return out + "…";
    out += ch;
    w++;
  }
  return out;
};

// Throttle leading + trailing.
function throttle<F extends (...args: never[]) => void>(fn: F, ms: number): F {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: never[]) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = undefined;
        fn(...args);
      }, wait);
    }
  }) as F;
}

const buildParams = (agents: AgentConfig[]) =>
  Type.Object({
    agent: Type.Union(
      agents.map((a) => Type.Literal(a.name)),
      { description: "Which subagent to dispatch" },
    ),
    task: Type.String({
      description:
        "Self-contained task description. Include all context the agent needs — file paths, constraints, expected output format.",
    }),
  });

type SubagentArgs = { agent: string; task: string };

const statusIcon = (theme: Theme, p: Progress): string => {
  if (p.status === "running") return theme.fg("warning", "⟳");
  if (p.status === "failed") return theme.fg("error", "✗");
  return theme.fg("success", "✓");
};

const renderCallComponent = (args: SubagentArgs, theme: Theme) => {
  const c = new Container();
  const head = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("text", args.agent)}`;
  c.addChild(new Text(head, 0, 0));
  // First line only, capped — the full task is often a multi-paragraph prompt
  // we don't want echoed into the conversation.
  const firstLine = args.task.split("\n", 1)[0] ?? "";
  const taskPreview =
    firstLine.length > TASK_PREVIEW_MAX
      ? firstLine.slice(0, TASK_PREVIEW_MAX - 1) + "…"
      : firstLine + (args.task.includes("\n") ? " …" : "");
  c.addChild(new Text(theme.fg("dim", `task: ${taskPreview}`), 0, 0));
  return c;
};

const renderProgressComponent = (
  p: Progress,
  theme: Theme,
  width: number,
  expanded: boolean,
) => {
  const c = new Container();
  const icon = statusIcon(theme, p);
  const model = theme.fg("dim", ` (${p.model})`);
  const header = `${icon} ${theme.fg("toolTitle", theme.bold(p.agent))}${model} ${theme.fg("dim", "—")} ${theme.fg("dim", formatDuration(p.durationMs))}`;
  c.addChild(new Text(fitLine(header, width), 0, 0));

  if (p.lastMessage && p.status === "running") {
    c.addChild(new Spacer(1));
    c.addChild(
      new Text(fitLine(theme.fg("text", `  ${p.lastMessage}`), width), 0, 0),
    );
  }

  if (p.error) {
    c.addChild(new Spacer(1));
    c.addChild(new Text(theme.fg("error", `  ${p.error}`), 0, 0));
  }

  if (p.status !== "running" && p.output) {
    c.addChild(new Spacer(1));
    if (expanded) {
      c.addChild(new Markdown(p.output, 0, 0, getMarkdownTheme()));
    } else {
      const lines = p.output.split("\n").length;
      const hint = `  ${lines} line${lines === 1 ? "" : "s"} (${keyText("app.tools.expand")} to expand)`;
      c.addChild(new Text(theme.fg("dim", hint), 0, 0));
    }
  }

  return c;
};

const initialProgress = (
  agent: AgentConfig,
  task: string,
  model: string,
): Progress => ({
  agent: agent.name,
  task,
  model,
  status: "running",
  startedAt: Date.now(),
  durationMs: 0,
  lastMessage: "",
  output: "",
});

function toolsFlagValue(
  agent: AgentConfig,
  pi: ExtensionAPI,
): string | undefined {
  if (agent.tools.length === 0) return undefined;
  const expanded = expandToolPatterns(
    agent.tools,
    pi.getAllTools().map((t) => t.name),
  );
  return expanded.length > 0 ? expanded.join(",") : undefined;
}

// The pi integration herdr installs reports agent state under this fixed
// source/agent pair (see the installed herdr-agent-state.ts extension).
// Releasing it right after we detect completion — well before herdr's
// default 1s notification delay expires — makes herdr re-check state at
// delivery time, see it no longer matches, and skip the "finished" toast/
// sound. A pane that goes "blocked" is left alone: that notification is the
// one case where the user's attention is actually wanted.
async function releaseAgentReport(paneId: string): Promise<void> {
  await herdrRun([
    "pane",
    "release-agent",
    paneId,
    "--source",
    "herdr:pi",
    "--agent",
    "pi",
  ]);
}

async function runInHerdr(
  pi: ExtensionAPI,
  agent: AgentConfig,
  task: string,
  cwd: string,
  progress: Progress,
  push: () => void,
  signal: AbortSignal | undefined,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Progress;
  error?: string;
}> {
  const target = `sub-${agent.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const sysFile = path.join(os.tmpdir(), `pi-subagent-sys-${target}.txt`);
  const taskFile = path.join(os.tmpdir(), `pi-subagent-task-${target}.txt`);
  fs.writeFileSync(sysFile, agent.systemPrompt, "utf-8");
  fs.writeFileSync(taskFile, task, "utf-8");
  const cleanupFiles = () => {
    try {
      fs.unlinkSync(sysFile);
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(taskFile);
    } catch {
      /* best effort */
    }
  };

  const toolsFlag = toolsFlagValue(agent, pi);
  const parts = [
    "pi",
    "--no-session",
    "--no-context-files",
    `--system-prompt "$(cat '${sysFile}')"`,
  ];
  if (toolsFlag) parts.push(`--tools ${toolsFlag}`);
  if (agent.model) parts.push(`--model ${agent.model}`);
  if (agent.thinking) parts.push(`--thinking ${agent.thinking}`);
  parts.push(`"$(cat '${taskFile}')"`);
  const shCmd = parts.join(" ");

  const paneId = await acquirePanelSlot(cwd, { PI_IS_SUBAGENT: "1" });
  if (!paneId) {
    cleanupFiles();
    progress.status = "failed";
    progress.error = "herdr pane split failed";
    return {
      content: [
        {
          type: "text",
          text: `subagent '${agent.name}' failed — could not open herdr pane`,
        },
      ],
      details: { ...progress },
      error: `Subagent ${agent.name}: herdr pane split failed`,
    };
  }

  await herdrRun(["pane", "run", paneId, shCmd]);

  let seenWorking = false;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const maxMs = agent.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  let finalStatus: "idle" | "blocked" | "timeout" | "aborted" = "idle";

  while (true) {
    if (aborted) {
      finalStatus = "aborted";
      break;
    }
    if (Date.now() - progress.startedAt > maxMs) {
      finalStatus = "timeout";
      break;
    }

    const info = await herdrJson<Record<string, any>>(["pane", "get", paneId]);
    const status: string | undefined = info?.result?.pane?.agent_status;
    if (status === "working") seenWorking = true;
    progress.lastMessage = status ? `herdr: ${status}` : "herdr: starting…";
    push();

    if (seenWorking && status === "idle") {
      finalStatus = "idle";
      break;
    }
    if (status === "blocked") {
      finalStatus = "blocked";
      break;
    }
    if (!status && seenWorking) {
      finalStatus = "idle"; // pane/agent vanished after having started
      break;
    }

    await sleep(HERDR_POLL_MS);
  }

  progress.durationMs = Date.now() - progress.startedAt;

  if (finalStatus === "aborted" || finalStatus === "timeout") {
    await releaseAgentReport(paneId);
    await herdrRun(["pane", "send-keys", paneId, "ctrl+c"]);
    await sleep(300);
    await releasePanelSlot(paneId);
    cleanupFiles();
    progress.status = "failed";
    progress.error =
      finalStatus === "timeout"
        ? `timed out after ${formatDuration(maxMs)} (wall clock)`
        : "aborted by parent";
    return {
      content: [
        { type: "text", text: `subagent '${agent.name}' ${progress.error}` },
      ],
      details: { ...progress },
      error: `Subagent ${agent.name}: ${progress.error}`,
    };
  }

  // "visible" only returns what currently fits on screen — wrong here since
  // the answer can scroll off during a long run. By now real scrollback has
  // accumulated, so "recent-unwrapped" (unlike right after pane creation) works.
  const rawOutput = await herdrText([
    "pane",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    "400",
  ]);
  const finalText = headTruncate(rawOutput.trim(), MAX_OUTPUT_BYTES);

  if (finalStatus === "blocked") {
    cleanupFiles();
    progress.status = "failed";
    progress.error =
      "subagent pane is blocked — needs manual attention (left open for review)";
    progress.output = finalText;
    return {
      content: [
        {
          type: "text",
          text: `subagent '${agent.name}' is blocked in herdr pane ${paneId} — check it directly.\n${finalText}`,
        },
      ],
      details: { ...progress },
      error: `Subagent ${agent.name}: blocked, see pane ${paneId}`,
    };
  }

  await releaseAgentReport(paneId);
  await releasePanelSlot(paneId);
  cleanupFiles();
  progress.status = "done";
  progress.output = finalText;
  return {
    content: [{ type: "text", text: finalText }],
    details: { ...progress },
  };
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") return;
  if (!herdrActive()) return;

  const agents = loadAgents();
  if (agents.length === 0) return;
  const byName = new Map(agents.map((a) => [a.name, a]));
  const agentList = agents
    .map((a) => `  ${a.name}: ${a.description}`)
    .join("\n");

  const params = buildParams(agents);

  pi.registerTool<typeof params, Progress | undefined>({
    name: "subagent",
    label: "Subagent",
    description:
      `Delegate a task to a specialized subagent running in isolation. ` +
      `Returns text only, and the task must include all context the subagent needs to act. ` +
      `Use to keep this session focused (offload web research, recon, or end-to-end implementation).\n\n` +
      `Available agents:\n${agentList}\n\n` +
      `Subagents cannot spawn further subagents.`,
    parameters: params,
    renderShell: "self",

    renderCall(args, theme) {
      return renderCallComponent(args as SubagentArgs, theme);
    },

    renderResult(result, options, theme) {
      const p = result.details;
      const w = (process.stdout.columns ?? 100) - 2;
      if (!p) {
        return new Text(theme.fg("dim", "  …"), 0, 0);
      }
      return renderProgressComponent(p, theme, w, options.expanded);
    },

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const args = rawParams as SubagentArgs;
      const agent = byName.get(args.agent);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown agent: ${args.agent}` }],
          details: undefined,
        };
      }

      const progress = initialProgress(
        agent,
        args.task,
        agent.model ?? "default",
      );

      // Throttled push so render redraws don't pile up under fast event bursts.
      const pushNow = () => {
        progress.durationMs = Date.now() - progress.startedAt;
        onUpdate?.({
          content: [{ type: "text", text: "" }],
          details: { ...progress },
        });
      };
      const push = throttle(pushNow, UPDATE_INTERVAL_MS);

      return await runInHerdr(
        pi,
        agent,
        args.task,
        ctx.cwd,
        progress,
        push,
        signal,
      );
    },
  });
}
