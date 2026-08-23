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
//   thinking: low                      # optional
//   maxDuration: 600                   # optional, seconds (wall-clock cap)
//   ---
//   <system prompt body>
//
// Status comes from notifier.ts, which sets the child pane's tmux pane title
// to reflect busy/ask/done — polled here instead of a parsed JSON event stream.

import { execFile } from "node:child_process";
import { parseStatusTitle } from "./shared/status";
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
  hidden: boolean;
  tools: string[];
  maxDurationMs?: number;
  systemPrompt: string;
}

// provider name -> model to use for every subagent when the parent session
// is on that provider (e.g. codex parent -> luna subagents, anthropic parent
// -> sonnet subagents). Same rule for all agents, no per-agent exceptions.
type ModelRoutingConfig = Record<string, string>;

const SUBAGENT_THINKING = "high";

interface Progress {
  id?: string;
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

// Live registry of every run this session has started (foreground or
// background), keyed by run id — backs subagent_manage's list (fleet overview) and
// steer/stop actions (by id). globalThis-backed like resultStore so
// an extension reload doesn't orphan runs still in flight.
interface RunRecord {
  id: string;
  paneId?: string;
  controller: AbortController;
  progress: Progress;
}
const runsStore = (() => {
  const g = globalThis as unknown as {
    __piSubagentRuns?: Map<string, RunRecord>;
  };
  return (g.__piSubagentRuns ??= new Map());
})();
const MAX_TRACKED_RUNS = 50;

// Bound the registry: drop oldest finished runs first once over the cap so a
// long session doesn't accumulate unbounded history; running ones are kept
// regardless of age.
function pruneRunsStore(): void {
  if (runsStore.size <= MAX_TRACKED_RUNS) return;
  const finished = [...runsStore.values()]
    .filter((r) => r.progress.status !== "running")
    .sort((a, b) => a.progress.startedAt - b.progress.startedAt);
  for (const r of finished) {
    if (runsStore.size <= MAX_TRACKED_RUNS) break;
    runsStore.delete(r.id);
  }
}

// Structured results captured from a run's trailing ```result-json block,
// keyed by the subagent's own target id ("sub-<agent>-<ts>-<rand>"), so the
// parent can pull one field instead of re-reading the whole transcript.
const resultStore = (() => {
  const g = globalThis as unknown as {
    __piSubagentResults?: Map<string, unknown>;
  };
  return (g.__piSubagentResults ??= new Map());
})();

// Trailing ```result-json fenced block a subagent ends its output with.
// Optional convention: only stripped/cached when present and valid JSON.
const RESULT_BLOCK_RE = /```result-json\s*\n([\s\S]*?)\n```\s*$/;

export function extractResultBlock(
  text: string,
  id: string,
): { text: string; captured: boolean } {
  const m = text.match(RESULT_BLOCK_RE);
  if (!m) return { text, captured: false };
  try {
    resultStore.set(id, JSON.parse(m[1]!));
  } catch {
    return { text, captured: false }; // invalid JSON stays ordinary transcript text
  }
  return { text: text.slice(0, m.index).trimEnd(), captured: true };
}

function getByPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur = obj;
  for (const key of path.split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const AGENTS_DIR = path.join(getAgentDir(), "agents");
const MODEL_MAP_PATH = path.join(AGENTS_DIR, "model-map.json");
const SYSTEM_PROMPT_PATH = path.join(getAgentDir(), "SYSTEM.md");
const MAX_OUTPUT_BYTES = 32 * 1024;
const UPDATE_INTERVAL_MS = 150;
const TASK_PREVIEW_MAX = 140;
const FORBIDDEN_TOOLS = new Set(["ask_user_question", "subagent"]);
const DEFAULT_MAX_DURATION_MS = 3_600_000;
const TMUX_POLL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const WAIT_POLL_MS = 500;

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
//
// The pane-id list lives on globalThis (pattern from go.ts): tmux panes
// survive an extension reload, so a module-scoped array would reset and
// orphan them, breaking the column layout.
const panelSlot = (() => {
  const g = globalThis as unknown as { __piSubagentPanel?: { ids: string[] } };
  if (!g.__piSubagentPanel) g.__piSubagentPanel = { ids: [] };
  return g.__piSubagentPanel;
})();
let panelChain: Promise<unknown> = Promise.resolve();

// Drop pane ids whose tmux pane is gone (killed manually, or leaked across a
// reload) so dead entries don't poison anchor choice and rebalancing.
async function prunePanel(): Promise<void> {
  const alive: string[] = [];
  for (const id of panelSlot.ids) {
    if (await tmuxOut(["display-message", "-p", "-t", id, "#{pane_id}"])) {
      alive.push(id);
    }
  }
  panelSlot.ids = alive;
}

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
  const panel = panelSlot.ids;
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
    await prunePanel();
    const anchor = panelSlot.ids.at(-1);
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
    if (paneId) panelSlot.ids.push(paneId);
    await rebalancePanel();
    return paneId || undefined;
  });
}

async function releasePanelSlot(paneId: string): Promise<void> {
  await withPanelLock(async () => {
    await tmuxRun(["kill-pane", "-t", paneId]);
    panelSlot.ids = panelSlot.ids.filter((id) => id !== paneId);
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
  let sharedPreamble = "";
  try {
    sharedPreamble = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trim();
  } catch {
    /* no shared SYSTEM.md — agents fall back to their own body only */
  }
  const out: AgentConfig[] = [];
  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(AGENTS_DIR, entry), "utf-8");
    } catch {
      continue;
    }
    // YAML scalars: strings for the flag-like fields, real boolean for `hidden`.
    const { frontmatter, body } = parseFrontmatter<
      Record<string, string | boolean | undefined> & { hidden?: boolean }
    >(content);
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    )
      continue;
    const tools = (
      typeof frontmatter.tools === "string" ? frontmatter.tools : ""
    )
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const secsToMs = (v: string | boolean | undefined): number | undefined => {
      const n = Number(typeof v === "string" ? v : undefined);
      return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
    };
    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      hidden: frontmatter.hidden === true,
      tools,
      maxDurationMs: secsToMs(frontmatter.maxDuration),
      // Same base system prompt as the main session (SYSTEM.md), with the
      // agent's own .md content appended — so every subagent shares the same
      // ground rules and only differs by its own file's addition.
      systemPrompt: `${sharedPreamble}\n\n${body.trim()}`,
    });
  }
  return out;
}

function loadModelRouting(): ModelRoutingConfig {
  try {
    return JSON.parse(
      fs.readFileSync(MODEL_MAP_PATH, "utf-8"),
    ) as ModelRoutingConfig;
  } catch {
    // Missing/malformed map must not break extension load; agents then
    // simply inherit the parent model.
    return {};
  }
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
    agent:
      agents.length === 1
        ? Type.Literal(agents[0]!.name, {
            description: "Agent route.",
          })
        : Type.Union(
            agents.map((agent) => Type.Literal(agent.name)),
            { description: "Agent route." },
          ),
    task: Type.String({
      description:
        "Self-contained brief: scope, paths, constraints, completion criteria, verification, and expected report.",
    }),
    model: Type.Optional(
      Type.String({
        description:
          "Optional provider/model override; otherwise use the parent provider's mapped model, then inherit the parent model.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Start without waiting; use subagent_manage to inspect or control the run.",
      }),
    ),
  });

type SubagentArgs = {
  agent: string;
  task: string;
  model?: string;
  background?: boolean;
};

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

// Shared by the four passive/control ops on already-tracked runs (list,
// result, steer, stop, wait) — one tool with an `action` enum instead of
// four, since they overlap heavily on `id` and none needs subagent's custom
// renderCall/renderResult.
const manageParams = () =>
  Type.Union([
    Type.Object({ action: Type.Literal("list") }),
    Type.Object({
      action: Type.Literal("result"),
      id: Type.String({ description: "Run id from subagent output or list." }),
      path: Type.Optional(
        Type.String({
          description:
            'Dot path into captured JSON, e.g. "findings.0.path"; omit for the whole object.',
        }),
      ),
    }),
    Type.Object({
      action: Type.Literal("steer"),
      id: Type.String({ description: "Running run id." }),
      message: Type.String({ description: "Follow-up text." }),
    }),
    Type.Object({
      action: Type.Literal("stop"),
      id: Type.String({ description: "Run id to abort." }),
    }),
    Type.Object({
      action: Type.Literal("wait"),
      id: Type.Optional(
        Type.String({ description: "Run id; omit for any running run." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: MAX_WAIT_TIMEOUT_MS,
          default: DEFAULT_WAIT_TIMEOUT_MS,
          description: "Wait limit in milliseconds.",
        }),
      ),
    }),
  ]);

type ManageArgs =
  | { action: "list" }
  | { action: "result"; id: string; path?: string }
  | { action: "steer"; id: string; message: string }
  | { action: "stop"; id: string }
  | { action: "wait"; id?: string; timeout_ms?: number };

const formatRunLine = (r: RunRecord): string => {
  const p = r.progress;
  const dur = formatDuration(
    p.status === "running" ? Date.now() - p.startedAt : p.durationMs,
  );
  const msg = p.status === "running" ? p.lastMessage : (p.error ?? "");
  return `${r.id}  [${p.status}]  ${p.agent}  ${dur}${msg ? `  — ${msg}` : ""}`;
};

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
async function runInTmux(
  pi: ExtensionAPI,
  agent: AgentConfig,
  task: string,
  model: string | undefined,
  thinking: string | undefined,
  cwd: string,
  progress: Progress,
  push: () => void,
  signal: AbortSignal | undefined,
  target: string,
  record: RunRecord,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Progress;
  error?: string;
}> {
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
  parts.push(`--exclude-tools ${[...FORBIDDEN_TOOLS].join(",")}`);
  if (model) parts.push(`--model '${model.replaceAll("'", "'\\''")}'`);
  if (thinking) parts.push(`--thinking ${thinking}`);
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
  record.paneId = paneId;

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
    const status = parseStatusTitle(paneTitle);
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
  // Extract before truncating: a valid result block may sit beyond the output
  // budget. Invalid blocks remain ordinary transcript text.
  const extracted = extractResultBlock(rawOutput.trim(), target);
  let finalText = headTruncate(extracted.text, MAX_OUTPUT_BYTES);
  if (extracted.captured) {
    finalText += `\n\n[structured result captured — id: ${target}. Use subagent_manage (action: result) to pull a field instead of re-reading this transcript.]`;
  }

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
  const modelRouting = loadModelRouting();
  const byName = new Map(agents.map((a) => [a.name, a]));
  // Hidden agents stay invocable (they're in the param enum) but pay no
  // per-turn description cost — a skill that knows the name invokes them.
  const agentList = agents
    .filter((a) => !a.hidden)
    .map((a) => {
      const summary = a.description.replace(/\s+/g, " ").trim();
      return `  ${a.name}: ${summary.length > 140 ? `${summary.slice(0, 137)}…` : summary}`;
    })
    .join("\n");

  const params = buildParams(agents);

  pi.registerTool<typeof params, Progress | undefined>({
    name: "subagent",
    label: "Subagent",
    description:
      `Delegate medium or large research, recon, or implementation work. Choose a route from the agent parameter; independent calls may run in parallel. ` +
      `The optional model overrides provider/model routing; otherwise the parent provider map is used, falling back to the parent model. ` +
      `Use background for asynchronous runs, then subagent_manage for status or control.\n\n` +
      `Routes:\n${agentList}\n\n` +
      "For a structured result, ask the subagent to end with a valid fenced ```result-json ... ``` block; retrieve fields with subagent_manage (action: result).",
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

      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      // Same rule for every agent: route to the model-map entry for the
      // parent's provider (codex parent -> luna, anthropic parent -> sonnet),
      // falling back to the parent's own model if unmapped.
      const model =
        args.model ??
        (ctx.model && modelRouting[ctx.model.provider]) ??
        parentModel;
      const thinking = SUBAGENT_THINKING;

      const target = `sub-${agent.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const progress = initialProgress(agent, args.task, model ?? "default");
      progress.id = target;

      // Own AbortController so subagent_manage can stop a background run
      // that has no live framework signal (its tool call already returned).
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) controller.abort();
        else
          signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
      }
      const record: RunRecord = { id: target, controller, progress };
      runsStore.set(target, record);
      pruneRunsStore();

      // Throttled push so render redraws don't pile up under fast event bursts.
      const pushNow = () => {
        progress.durationMs = Date.now() - progress.startedAt;
        onUpdate?.({
          content: [{ type: "text", text: "" }],
          details: { ...progress },
        });
      };
      const push = throttle(pushNow, UPDATE_INTERVAL_MS);

      const runPromise = runInTmux(
        pi,
        agent,
        args.task,
        model,
        thinking,
        ctx.cwd,
        progress,
        push,
        controller.signal,
        target,
        record,
      );

      if (args.background) {
        // Fire-and-forget: runInTmux mutates `progress` (shared with the
        // record already in runsStore) as it goes, so subagent_manage (list) sees
        // live state without us awaiting here.
        runPromise.catch((err) => {
          progress.status = "failed";
          progress.error = String(err);
        });
        return {
          content: [
            {
              type: "text",
              text: `subagent '${agent.name}' started in background (id: ${target}). Use subagent_manage to check on it, steer/stop it, or pull its result if it ends with a result-json block.`,
            },
          ],
          details: { ...progress },
        };
      }

      return await runPromise;
    },
  });

  pi.registerTool<ReturnType<typeof manageParams>, undefined>({
    name: "subagent_manage",
    label: "Subagent Manage",
    description:
      "Inspect or control tracked subagent runs; choose an action and provide only that action's fields.",
    parameters: manageParams(),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as ManageArgs;
      const action = params.action;
      const id = "id" in params ? params.id : undefined;
      const fieldPath = "path" in params ? params.path : undefined;
      const message = "message" in params ? params.message : undefined;
      const timeout_ms = "timeout_ms" in params ? params.timeout_ms : undefined;

      if (action === "list") {
        const runs = [...runsStore.values()].sort(
          (a, b) => b.progress.startedAt - a.progress.startedAt,
        );
        const text =
          runs.length === 0
            ? "No subagent runs tracked this session."
            : runs.map(formatRunLine).join("\n");
        return { content: [{ type: "text", text }], details: undefined };
      }

      if (action === "wait") {
        if (id && !runsStore.has(id)) {
          const msg = `subagent_manage: no tracked run with id "${id}"`;
          return {
            content: [{ type: "text", text: msg }],
            details: undefined,
            error: msg,
          };
        }
        const targets = id
          ? [runsStore.get(id)!]
          : [...runsStore.values()].filter(
              (r) => r.progress.status === "running",
            );
        if (targets.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "subagent_manage: no runs currently running.",
              },
            ],
            details: undefined,
          };
        }
        const timeoutMs = Math.min(
          Math.max(timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS, 1000),
          MAX_WAIT_TIMEOUT_MS,
        );
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const finished = targets.filter(
            (r) => r.progress.status !== "running",
          );
          if (finished.length > 0) {
            return {
              content: [
                { type: "text", text: finished.map(formatRunLine).join("\n") },
              ],
              details: undefined,
            };
          }
          if (Date.now() >= deadline) {
            const label =
              targets.length === 1
                ? targets[0]!.id
                : `${targets.length} run(s)`;
            return {
              content: [
                {
                  type: "text",
                  text: `subagent_manage: timed out after ${formatDuration(timeoutMs)} waiting on ${label}.`,
                },
              ],
              details: undefined,
            };
          }
          await sleep(WAIT_POLL_MS);
        }
      }

      if (!id) {
        const msg = `subagent_manage: 'id' is required for action '${action}'.`;
        return {
          content: [{ type: "text", text: msg }],
          details: undefined,
          error: msg,
        };
      }

      if (action === "result") {
        if (!resultStore.has(id)) {
          const msg = `subagent_manage: no structured result captured for id "${id}"`;
          return {
            content: [{ type: "text", text: msg }],
            details: undefined,
            error: msg,
          };
        }
        const value = getByPath(resultStore.get(id), fieldPath);
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          details: undefined,
        };
      }

      // steer / stop
      const record = runsStore.get(id);
      if (!record) {
        const msg = `subagent_manage: no tracked run with id "${id}"`;
        return {
          content: [{ type: "text", text: msg }],
          details: undefined,
          error: msg,
        };
      }
      if (action === "stop") {
        record.controller.abort();
        return {
          content: [
            {
              type: "text",
              text: `subagent '${record.progress.agent}' (${id}) stop requested.`,
            },
          ],
          details: undefined,
        };
      }
      // steer
      if (record.progress.status !== "running" || !record.paneId) {
        const msg = `subagent_manage: run "${id}" is not running, cannot steer.`;
        return {
          content: [{ type: "text", text: msg }],
          details: undefined,
          error: msg,
        };
      }
      if (!message) {
        const msg =
          "subagent_manage: 'message' is required for action 'steer'.";
        return {
          content: [{ type: "text", text: msg }],
          details: undefined,
          error: msg,
        };
      }
      await tmuxRun(["send-keys", "-t", record.paneId, "-l", message]);
      await tmuxRun(["send-keys", "-t", record.paneId, "Enter"]);
      return {
        content: [
          {
            type: "text",
            text: `sent to subagent '${record.progress.agent}' (${id}).`,
          },
        ],
        details: undefined,
      };
    },
  });
}
