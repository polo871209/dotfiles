// /subagent — delegate work to an isolated `pi` running as a real interactive
// agent inside its own tmux pane, split off the calling pane. Single-layer
// only: agents cannot spawn other subagents (PI_IS_SUBAGENT=1 in the child
// env makes this extension early-exit before registering its tool). tmux-only:
// outside tmux there is no pane to split, so the tool is not registered at all.
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
// Status comes from notifier.ts, which sets the child pane's tmux pane title
// to reflect busy/ask/done — polled here instead of a parsed JSON event stream.

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
const TMUX_POLL_MS = 500;

const execFileAsync = promisify(execFile);

function tmuxActive(): boolean {
  return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

// tmux prints plain text on stdout, not JSON — every helper here just trims it.
async function tmuxOut(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", args, {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function tmuxRun(args: string[]): Promise<boolean> {
  try {
    await execFileAsync("tmux", args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// Shared panel: concurrent subagents stack in one vertical column instead of
// each carving a fresh horizontal slice out of the calling pane. The first
// subagent splits off the calling pane (side column); later concurrent ones
// split the previous subagent's pane downward, so the column's width never
// grows with agent count. A promise chain serializes the split/close calls
// that mutate the shared panel list so concurrent executions can't race each
// other's layout changes.
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

// Give every pane in the panel column equal height instead of the halving
// cascade split-window's default 50/50 would produce (1st pane 50%, 2nd 25%,
// 3rd 12.5%, ...). Resizing all but the last is enough — tmux gives the last
// pane whatever's left, which lands on the same equal share by construction.
async function rebalancePanel(): Promise<void> {
  if (panel.length < 2) return;
  const totalHeight = Number(
    await tmuxOut([
      "display-message",
      "-t",
      panel[0]!,
      "-p",
      "#{window_height}",
    ]),
  );
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return;
  const share = Math.floor(totalHeight / panel.length);
  for (const id of panel.slice(0, -1)) {
    await tmuxRun(["resize-pane", "-t", id, "-y", String(share)]);
  }
}

async function acquirePanelSlot(
  cwd: string,
  shCmd: string,
): Promise<string | undefined> {
  return withPanelLock(async () => {
    const anchor = panel.at(-1);
    const args = anchor
      ? [
          "split-window",
          "-d",
          "-v",
          "-c",
          cwd,
          "-t",
          anchor,
          "-P",
          "-F",
          "#{pane_id}",
          "--",
          "zsh",
          "-lc",
          shCmd,
        ]
      : [
          "split-window",
          "-d",
          "-h",
          "-p",
          "25",
          "-c",
          cwd,
          "-t",
          process.env.TMUX_PANE!,
          "-P",
          "-F",
          "#{pane_id}",
          "--",
          "zsh",
          "-lc",
          shCmd,
        ];
    const paneId = await tmuxOut(args);
    if (paneId) panel.push(paneId);
    await rebalancePanel();
    return paneId || undefined;
  });
}

async function releasePanelSlot(paneId: string): Promise<void> {
  await withPanelLock(async () => {
    await tmuxRun(["kill-pane", "-t", paneId]);
    panel = panel.filter((id) => id !== paneId);
    await rebalancePanel();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Pane-title status suffix notifier.ts sets for a subagent pane (see
// notifier.ts's setWindowStatus): "<title>-busy" / "-ask" / "-done" / "-idle".
// A dedicated pane title (not the shared window name) because the subagent
// pane lives inside the parent's own window.
function paneStatusSuffix(paneTitle: string): string | undefined {
  const idx = paneTitle.lastIndexOf("-");
  return idx === -1 ? undefined : paneTitle.slice(idx + 1);
}

async function runInTmux(
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
    "PI_IS_SUBAGENT=1",
    "pi",
    "--no-session",
    "--no-context-files",
    `--system-prompt "$(cat '${sysFile}')"`,
  ];
  if (toolsFlag) parts.push(`--tools ${toolsFlag}`);
  if (agent.model) parts.push(`--model ${agent.model}`);
  if (agent.thinking) parts.push(`--thinking ${agent.thinking}`);
  parts.push(`"$(cat '${taskFile}')"`);
  // Real interactive pi, not --print: the task is the initial prompt, then
  // pi stays running and idle in the pane afterward — watchable, and you can
  // type into it directly to steer or follow up.
  const shCmd = parts.join(" ");

  const paneId = await acquirePanelSlot(cwd, shCmd);
  if (!paneId) {
    cleanupFiles();
    progress.status = "failed";
    progress.error = "tmux split-window failed";
    return {
      content: [
        {
          type: "text",
          text: `subagent '${agent.name}' failed — could not open tmux pane`,
        },
      ],
      details: { ...progress },
      error: `Subagent ${agent.name}: tmux split-window failed`,
    };
  }
  // Best effort: name the pane after the subagent for readability before
  // notifier.ts (running inside it) takes over with status suffixes.
  void tmuxRun(["select-pane", "-t", paneId, "-T", target]);

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

    const paneTitle = await tmuxOut([
      "display-message",
      "-t",
      paneId,
      "-p",
      "#{pane_title}",
    ]);
    const status = paneStatusSuffix(paneTitle);
    progress.lastMessage = status ? `tmux: ${status}` : "tmux: starting…";
    push();

    // notifier.ts only ever sets "done" from a real agent_end, and a subagent
    // pane is never OS-focused, so "done" (not the ambiguous initial "idle")
    // is the terminal signal here — no need to first observe "busy".
    if (status === "done") {
      finalStatus = "idle";
      break;
    }
    if (status === "blocked") {
      finalStatus = "blocked";
      break;
    }
    if (!paneTitle) {
      finalStatus = "idle"; // pane vanished
      break;
    }

    await sleep(TMUX_POLL_MS);
  }

  progress.durationMs = Date.now() - progress.startedAt;

  if (finalStatus === "aborted" || finalStatus === "timeout") {
    await tmuxRun(["send-keys", "-t", paneId, "C-c"]);
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

  const rawOutput = await tmuxOut([
    "capture-pane",
    "-p",
    "-J",
    "-t",
    paneId,
    "-S",
    "-400",
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
          text: `subagent '${agent.name}' is blocked in tmux pane ${paneId} — check it directly.\n${finalText}`,
        },
      ],
      details: { ...progress },
      error: `Subagent ${agent.name}: blocked, see pane ${paneId}`,
    };
  }

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
  if (!tmuxActive()) return;

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

      return await runInTmux(
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
