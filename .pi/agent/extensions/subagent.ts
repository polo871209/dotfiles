// Agents live in pi's standard agents dir (`~/.pi/agent/agents/*.md`) as
// markdown with YAML frontmatter:
//   ---
//   name: researcher
//   description: ...
//   tools: read, grep, find, ls       # optional --tools allowlist
//   hidden: true                       # optional, invocable but not listed
//   model: anthropic/claude-sonnet-5-5 # optional, overrides the provider default
//   thinking: low                      # optional, defaults to the main agent's level
//   ---
//   <body, appended to the child's own system prompt>

import { execFile, execFileSync } from "node:child_process";
import { collectTextMessages, extractText } from "./shared/message";
import { parseStatusTitle } from "./shared/status";
import { surviveReload } from "./shared/reload";
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
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

interface AgentConfig {
  name: string;
  description: string;
  hidden: boolean;
  tools: string[];
  appendPrompt: string;
  model?: string;
  thinking?: ThinkingLevel;
}

// pi exports the ThinkingLevel type but not its isValidThinkingLevel check.
const THINKING_LEVELS: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);

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

interface RunRecord {
  id: string;
  sessionId: string;
  paneId?: string;
  controller: AbortController;
  progress: Progress;
  settled?: Promise<void>;
}
const runsStore = surviveReload(
  "__piSubagentRuns",
  () => new Map<string, RunRecord>(),
);
const MAX_TRACKED_RUNS = 50;

function pruneRunsStore(): void {
  if (runsStore.size <= MAX_TRACKED_RUNS) return;
  for (const r of [...runsStore.values()]
    .filter((r) => r.progress.status !== "running")
    .sort((a, b) => a.progress.startedAt - b.progress.startedAt)) {
    if (runsStore.size <= MAX_TRACKED_RUNS) break;
    runsStore.delete(r.id);
  }
}

const RESULT_ENTRY_TYPE = "subagent-result";
interface ResultEntry {
  id: string;
  value: unknown;
}

const resultStore = surviveReload(
  "__piSubagentResults",
  () => new Map<string, unknown>(),
);

const RUN_ENTRY_TYPE = "subagent-run";
interface RunEntry {
  id: string;
  agent: string;
  status: Progress["status"];
  error?: string;
}

const interruptedRuns = new Map<string, RunEntry>();

const sink = surviveReload(
  "__piSubagentSink",
  (): {
    sessionId?: string;
    append?: (type: string, data: unknown) => void;
  } => ({}),
);

function persist(sessionId: string, type: string, data: unknown): void {
  if (sink.sessionId !== sessionId) return;
  try {
    sink.append?.(type, data);
  } catch {}
}

let persistResult: ((id: string, value: unknown) => void) | undefined;

function hydrateResultStore(entries: readonly { type: string }[]): void {
  const lastRun = new Map<string, RunEntry>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const custom = entry as { customType?: string; data?: unknown };
    if (custom.customType === RESULT_ENTRY_TYPE) {
      const data = custom.data as ResultEntry | undefined;
      if (data?.id) resultStore.set(data.id, data.value);
    } else if (custom.customType === RUN_ENTRY_TYPE) {
      const data = custom.data as RunEntry | undefined;
      if (data?.id) lastRun.set(data.id, data);
    }
  }
  interruptedRuns.clear();
  for (const run of lastRun.values()) {
    if (run.status === "running" && !runsStore.has(run.id))
      interruptedRuns.set(run.id, run);
  }
}

const INTERRUPTED_ERROR =
  "interrupted: pi stopped while this run was in progress, so its work may be partial. Start a new run if the answer is still needed.";

function interruptedValue(run: RunEntry): Static<typeof RunValueSchema> {
  return {
    id: run.id,
    agent: run.agent,
    status: "failed",
    output: "",
    error: INTERRUPTED_ERROR,
  };
}

function extractResultBlock(
  text: string,
  id: string,
): { text: string; captured: boolean } {
  let hit: { value: unknown; index: number } | undefined;
  for (const m of text.matchAll(/```result-json\s*\n([\s\S]*?)\n```/g)) {
    try {
      hit = { value: JSON.parse(m[1]!), index: m.index };
    } catch {}
  }
  if (!hit) return { text, captured: false };
  resultStore.set(id, hit.value);
  persistResult?.(id, hit.value);
  return { text: text.slice(0, hit.index).trimEnd(), captured: true };
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

const RunValueSchema = Type.Object({
  id: Type.String(),
  agent: Type.String(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
  ]),
  output: Type.String(),
  result: Type.Optional(
    Type.Unknown({ description: "Parsed result-json block, when present" }),
  ),
  error: Type.Optional(Type.String()),
});

function runValue(
  p: Progress,
  fieldPath?: string,
): Static<typeof RunValueSchema> & JsonValue {
  const id = p.id ?? "";
  return {
    id,
    agent: p.agent,
    status: p.status,
    output: p.output,
    ...(resultStore.has(id)
      ? { result: getByPath(resultStore.get(id), fieldPath) as JsonValue }
      : {}),
    ...(p.error ? { error: p.error } : {}),
  };
}

const ManageValueSchema = Type.Object({
  outcome: Type.Optional(
    Type.Union(
      [
        Type.Literal("finished"),
        Type.Literal("timeout"),
        Type.Literal("aborted"),
      ],
      { description: "wait only" },
    ),
  ),
  runs: Type.Array(RunValueSchema),
});
const manageValue = (v: Static<typeof ManageValueSchema>): JsonValue =>
  v as JsonValue;

const AGENTS_DIR = path.join(getAgentDir(), "agents");
const MAX_OUTPUT_BYTES = 32 * 1024;
const TASK_PREVIEW_MAX = 140;
const FORBIDDEN_TOOLS = new Set(["ask_user_question", "subagent"]);
const DEFAULT_MAX_DURATION_MS = 3_600_000;
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_MAX_DURATION_MS + 60_000;

const execFileAsync = promisify(execFile);

function tmuxActive(): boolean {
  return !!process.env.TMUX && !!process.env.TMUX_PANE;
}

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

const panelSlot = surviveReload("__piSubagentPanel", () => ({
  ids: [] as string[],
}));
let panelChain: Promise<unknown> = Promise.resolve();

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
  for (const id of panel.slice(0, -1)) {
    await tmuxRun([
      "resize-pane",
      "-t",
      id,
      "-y",
      String(Math.floor(totalHeight / panel.length)),
    ]);
  }
}

async function acquirePanelSlot(
  cwd: string,
  shCmd: string,
): Promise<string | undefined> {
  return withPanelLock(async () => {
    await prunePanel();
    const anchor = panelSlot.ids.at(-1);
    const paneId = await tmuxOut(
      anchor
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
          ],
    );
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
    for (const n of allNames) {
      if (FORBIDDEN_TOOLS.has(n)) continue;
      if (
        new RegExp(
          "^" +
            p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
            "$",
        ).test(n)
      )
        out.add(n);
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
    const { frontmatter, body } = parseFrontmatter<
      Record<string, string | boolean | undefined> & { hidden?: boolean }
    >(content);
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    )
      continue;
    const { model, thinking } = frontmatter;
    if (model !== undefined && typeof model !== "string")
      throw new Error(`${entry}: model must be a string`);
    if (thinking !== undefined && !isThinkingLevel(thinking))
      throw new Error(
        `${entry}: thinking must be one of ${Object.keys(THINKING_LEVELS).join(", ")}`,
      );
    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      hidden: frontmatter.hidden === true,
      tools: (typeof frontmatter.tools === "string" ? frontmatter.tools : "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      appendPrompt: body.trim(),
      model,
      thinking,
    });
  }
  return out;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
};

const headTruncate = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf-8") + "\n…(truncated)";
};

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
        "Self-contained brief: scope, paths, constraints, completion criteria, and expected report. " +
        "No session history carries over.",
    }),
    background: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Return a run id instead of the result, for work that runs alongside yours. Default false blocks and returns the result.",
      }),
    ),
  });

type SubagentArgs = {
  agent: string;
  task: string;
  background?: boolean;
};

const statusIcon = (theme: Theme, p: Progress): string => {
  if (p.status === "running") return theme.fg("warning", "⟳");
  if (p.status === "failed") return theme.fg("error", "✗");
  return theme.fg("success", "✓");
};

const renderCallComponent = (args: SubagentArgs, theme: Theme) => {
  const c = new Container();
  c.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("text", args.agent)}`,
      0,
      0,
    ),
  );
  const firstLine = args.task.split("\n", 1)[0] ?? "";
  c.addChild(
    new Text(
      theme.fg(
        "dim",
        `task: ${
          firstLine.length > TASK_PREVIEW_MAX
            ? firstLine.slice(0, TASK_PREVIEW_MAX - 1) + "…"
            : firstLine + (args.task.includes("\n") ? " …" : "")
        }`,
      ),
      0,
      0,
    ),
  );
  return c;
};

const renderProgressComponent = (
  p: Progress,
  theme: Theme,
  width: number,
  expanded: boolean,
) => {
  const c = new Container();
  c.addChild(
    new Text(
      fitLine(
        `${statusIcon(theme, p)} ${theme.fg("toolTitle", theme.bold(p.agent))}${theme.fg("dim", ` (${p.model})`)} ${theme.fg("dim", "—")} ${theme.fg("dim", formatDuration(p.durationMs))}`,
        width,
      ),
      0,
      0,
    ),
  );

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
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `  ${lines} line${lines === 1 ? "" : "s"} (${keyText("app.tools.expand")} to expand)`,
          ),
          0,
          0,
        ),
      );
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

// One flat object, not a union: providers render a top-level union as `anyOf`,
// so a near-miss argument returns a per-branch error dump the model burns turns
// retrying. Flat schema plus runtime field checks give one actionable error
// line.
const MANAGE_ACTIONS = [
  "wait",
  "result",
  "steer",
  "stop",
] as const satisfies readonly ManageAction[];

const manageParams = () =>
  Type.Object({
    action: Type.Union(
      MANAGE_ACTIONS.map((a) => Type.Literal(a)),
      {
        description:
          "wait: block until the given runs (or all running ones) finish, then return each one's output. This is the only call a background run needs. result: re-read a finished run's output later. steer: send follow-up text into the run. stop: abort the run.",
      },
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Run id as printed by the subagent call. Required for result, steer, stop. wait and result take a comma-separated list; for wait, omit it to cover every running run.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description:
          "wait only: give up after this many seconds and report what is still running. Default waits for the runs' own duration cap.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          'result only: dot path into captured result-json, e.g. "findings.0.path"; omit for the whole object.',
      }),
    ),
    message: Type.Optional(
      Type.String({ description: "steer only: follow-up text." }),
    ),
  });

type ManageAction = "wait" | "result" | "steer" | "stop";

type ManageArgs = {
  action: ManageAction;
  id?: string;
  path?: string;
  message?: string;
  timeoutSeconds?: number;
};

const formatRunLine = (r: RunRecord): string => {
  const p = r.progress;
  const msg = p.status === "running" ? p.lastMessage : (p.error ?? "");
  return `${r.id}  [${p.status}]  ${p.agent}  ${formatDuration(
    p.status === "running" ? Date.now() - p.startedAt : p.durationMs,
  )}${msg ? `  — ${msg}` : ""}`;
};

const runPayload = (
  id: string,
  transcript: string,
  fieldPath?: string,
): string => {
  if (resultStore.has(id)) {
    return headTruncate(
      JSON.stringify(getByPath(resultStore.get(id), fieldPath), null, 2),
      MAX_OUTPUT_BYTES,
    );
  }
  return transcript || "(no output)";
};

const transcriptOf = (r: RunRecord): string =>
  r.progress.output || r.progress.error || "";

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
  trusted: boolean,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Progress;
  isError?: boolean;
}> {
  const promptFile = path.join(os.tmpdir(), `pi-subagent-sys-${target}.txt`);
  const taskFile = path.join(os.tmpdir(), `pi-subagent-task-${target}.txt`);
  const resultFile = path.join(os.tmpdir(), `pi-subagent-result-${target}.txt`);
  fs.writeFileSync(promptFile, agent.appendPrompt, { mode: 0o600 });
  fs.writeFileSync(taskFile, task, { mode: 0o600 });
  const cleanupFiles = () => {
    for (const f of [promptFile, taskFile, resultFile, `${resultFile}.tmp`]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  };

  const toolsFlag = toolsFlagValue(agent, pi);
  const parts = [
    "PI_IS_SUBAGENT=1",
    `PI_SUBAGENT_RESULT_FILE='${resultFile}'`,
    "pi",
    "--no-session",
    `--append-system-prompt '${promptFile}'`,
  ];
  parts.push(trusted ? "--approve" : "--no-approve");
  if (toolsFlag) parts.push(`--tools ${toolsFlag}`);
  parts.push(`--exclude-tools ${[...FORBIDDEN_TOOLS].join(",")}`);
  if (model) parts.push(`--model '${model.replaceAll("'", "'\\''")}'`);
  if (thinking) parts.push(`--thinking ${thinking}`);
  parts.push(`"$(cat '${taskFile}')"`);

  const paneId = await acquirePanelSlot(cwd, parts.join(" "));
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
      isError: true,
    };
  }
  void tmuxRun(["select-pane", "-t", paneId, "-T", target]);
  record.paneId = paneId;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  let finalStatus: "idle" | "blocked" | "timeout" | "aborted" = "idle";

  while (true) {
    if (aborted) {
      finalStatus = "aborted";
      break;
    }
    if (Date.now() - progress.startedAt > DEFAULT_MAX_DURATION_MS) {
      finalStatus = "timeout";
      break;
    }

    if (fs.existsSync(resultFile)) {
      finalStatus = "idle";
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

    if (status === "done") {
      finalStatus = "idle";
      break;
    }
    if (status === "blocked") {
      finalStatus = "blocked";
      break;
    }
    if (!paneTitle) {
      finalStatus = "idle";
      break;
    }

    await sleep(500);
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
        ? `timed out after ${formatDuration(DEFAULT_MAX_DURATION_MS)} (wall clock)`
        : "aborted by parent";
    return {
      content: [
        { type: "text", text: `subagent '${agent.name}' ${progress.error}` },
      ],
      details: { ...progress },
      isError: true,
    };
  }

  let rawOutput = "";
  if (finalStatus === "idle") {
    try {
      rawOutput = fs.readFileSync(resultFile, "utf-8").trim();
    } catch {}
  }
  if (!rawOutput) {
    rawOutput = (
      await tmuxOut(["capture-pane", "-p", "-J", "-t", paneId, "-S", "-"])
    ).trim();
  }
  const extracted = extractResultBlock(rawOutput, target);
  let finalText = headTruncate(extracted.text, MAX_OUTPUT_BYTES);
  if (extracted.captured) {
    finalText += `\n\n[result-json cached as ${target}; reachable later with subagent_manage (action: result).]`;
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
      isError: true,
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

function registerChildResultMirror(pi: ExtensionAPI): void {
  const file = process.env.PI_SUBAGENT_RESULT_FILE;
  if (!file) return;
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const { messages } = collectTextMessages(ctx.sessionManager.getBranch());
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== "assistant") continue;
        const text = extractText(m.content).trim();
        if (!text) continue;
        fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
        break;
      }
    } catch {}
  });
}

function sweepStaleRunFiles(): void {
  const cutoff = Date.now() - DEFAULT_WAIT_TIMEOUT_MS * 2;
  const dir = os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("pi-subagent-")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") {
    registerChildResultMirror(pi);
    return;
  }
  if (!tmuxActive()) return;

  sink.append = (type, data) => pi.appendEntry(type, data);
  persistResult = (id, value) => {
    const sessionId = runsStore.get(id)?.sessionId;
    if (sessionId) persist(sessionId, RESULT_ENTRY_TYPE, { id, value });
  };
  pi.on("session_start", async (event, ctx) => {
    sink.sessionId = ctx.sessionManager.getSessionId();
    if (event.reason === "startup") sweepStaleRunFiles();
    if (event.reason !== "startup" && event.reason !== "reload")
      resultStore.clear();
    hydrateResultStore(ctx.sessionManager.getBranch());
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    for (const record of runsStore.values()) {
      if (record.progress.status !== "running") continue;
      record.controller.abort();
      if (!record.paneId) continue;
      try {
        execFileSync("tmux", ["kill-pane", "-t", record.paneId], {
          timeout: 2_000,
        });
      } catch {}
    }
  });

  const agents = loadAgents();
  if (agents.length === 0) return;

  const params = buildParams(agents);

  pi.registerTool<typeof params, Progress | undefined>({
    name: "subagent",
    label: "Subagent",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    promptSnippet:
      "Delegate work that needs its own context to an isolated agent",
    description:
      `Delegate work that needs a context of its own to an isolated agent. Do the rest in the main thread. Independent calls run in parallel.\n\n` +
      `Routes:\n${agents
        .filter((a) => !a.hidden)
        .map((a) => {
          const summary = a.description.replace(/\s+/g, " ").trim();
          return `  ${a.name}: ${summary.length > 140 ? `${summary.slice(0, 137)}…` : summary}`;
        })
        .join("\n")}\n\n` +
      "For a compact hand-back, tell the subagent to end with a fenced ```result-json ... ``` block: a background run's wait returns it, and subagent_manage (action: result, path) pulls one field.",
    parameters: params,
    outputSchema: RunValueSchema,
    renderShell: "self",

    renderCall(args, theme) {
      return renderCallComponent(args as SubagentArgs, theme);
    },

    renderResult(result, options, theme) {
      const p = result.details;
      if (!p) {
        return new Text(theme.fg("dim", "  …"), 0, 0);
      }
      return {
        render: (width: number) =>
          renderProgressComponent(p, theme, width - 2, options.expanded).render(
            width,
          ),
        invalidate: () => {},
      };
    },

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const args = rawParams as SubagentArgs;
      const agent = agents.find((a) => a.name === args.agent);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown agent: ${args.agent}` }],
          details: undefined,
          isError: true,
        };
      }
      const model =
        agent.model ??
        (ctx.model &&
          (
            {
              anthropic: "anthropic/claude-sonnet-5-5",
            } satisfies Record<string, string>
          )[ctx.model.provider]) ??
        (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

      const target = `sub-${agent.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const progress = initialProgress(agent, args.task, model ?? "default");
      progress.id = target;

      const controller = new AbortController();
      if (signal && !args.background) {
        if (signal.aborted) controller.abort();
        else
          signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const record: RunRecord = { id: target, sessionId, controller, progress };
      runsStore.set(target, record);
      pruneRunsStore();
      persist(sessionId, RUN_ENTRY_TYPE, {
        id: target,
        agent: agent.name,
        status: "running",
      } satisfies RunEntry);

      const runPromise = runInTmux(
        pi,
        agent,
        args.task,
        model,
        agent.thinking ?? pi.getThinkingLevel(),
        ctx.cwd,
        progress,
        throttle(() => {
          progress.durationMs = Date.now() - progress.startedAt;
          onUpdate?.({
            content: [{ type: "text", text: "" }],
            details: { ...progress },
          });
        }, 150),
        controller.signal,
        target,
        record,
        ctx.isProjectTrusted(),
      );

      record.settled = runPromise
        .then(
          () => undefined,
          (err) => {
            progress.status = "failed";
            progress.error = String(err);
          },
        )
        .then(() =>
          persist(sessionId, RUN_ENTRY_TYPE, {
            id: target,
            agent: agent.name,
            status: progress.status,
            ...(progress.error ? { error: progress.error } : {}),
          } satisfies RunEntry),
        );

      if (args.background) {
        return {
          content: [
            {
              type: "text",
              text: `subagent '${agent.name}' running in background, id ${target}. Carry on with other work, then make one subagent_manage (action: wait) call: it blocks until the run ends and returns its output.`,
            },
          ],
          details: { ...progress },
          structuredContent: runValue(progress),
        };
      }

      return { ...(await runPromise), structuredContent: runValue(progress) };
    },
  });

  pi.registerTool<ReturnType<typeof manageParams>, undefined>({
    name: "subagent_manage",
    label: "Subagent Manage",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    promptSnippet: "Wait for, read, steer, or stop subagent runs",
    description:
      "Inspect or control background subagent runs started this session. A foreground run already returned its output, so it needs no call here.\n\n" +
      "WRONG: sleep in a shell, or call result after a wait — each spends a turn on information you already have.\n" +
      "RIGHT: keep working, then one wait call at the point the runs gate your next step. It returns their output the moment they finish.",
    parameters: manageParams(),
    outputSchema: ManageValueSchema,
    async execute(_toolCallId, rawParams, signal) {
      const {
        action: rawAction,
        id,
        path: fieldPath,
        message,
        timeoutSeconds,
      } = rawParams as ManageArgs;

      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: undefined,
        isError: true,
      });

      const action =
        (
          {
            list: "wait",
            status: "wait",
            transcript: "result",
            output: "result",
            log: "result",
            logs: "result",
            tail: "result",
            peek: "result",
            view: "result",
            kill: "stop",
            message: "steer",
          } satisfies Record<string, ManageAction>
        )[String(rawAction).toLowerCase()] ?? rawAction;
      if (!MANAGE_ACTIONS.includes(action)) {
        return fail(
          `subagent_manage: unknown action '${String(rawAction)}'. Valid: ${MANAGE_ACTIONS.join(", ")}.`,
        );
      }

      if (action === "wait") {
        const wanted = (id ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const interrupted = wanted
          .filter((runId) => !runsStore.has(runId))
          .map((runId) => interruptedRuns.get(runId))
          .filter((run): run is RunEntry => run !== undefined);
        const unknown = wanted.filter(
          (runId) => !runsStore.has(runId) && !interruptedRuns.has(runId),
        );
        if (unknown.length > 0) {
          return fail(
            `subagent_manage: no tracked run with id ${unknown.map((u) => `"${u}"`).join(", ")}`,
          );
        }
        const records =
          wanted.length > 0
            ? wanted.flatMap((runId) => runsStore.get(runId) ?? [])
            : [...runsStore.values()].filter(
                (r) => r.progress.status === "running",
              );
        if (records.length === 0 && interrupted.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: interrupted
                  .map((r) => `${r.id}  [interrupted]  ${r.agent}`)
                  .concat(INTERRUPTED_ERROR)
                  .join("\n"),
              },
            ],
            details: undefined,
            isError: true,
            structuredContent: manageValue({
              outcome: "finished",
              runs: interrupted.map(interruptedValue),
            }),
          };
        }
        if (records.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent runs to wait for." }],
            details: undefined,
            structuredContent: manageValue({ outcome: "finished", runs: [] }),
          };
        }

        const timeoutMs =
          timeoutSeconds && timeoutSeconds > 0
            ? timeoutSeconds * 1000
            : DEFAULT_WAIT_TIMEOUT_MS;
        // Held in an object: TS narrows a plain `let` to its initializer and
        // then rejects the comparisons below, since both writes are in callbacks.
        const state: { outcome: "finished" | "timeout" | "aborted" } = {
          outcome: "finished",
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(records.map((r) => r.settled ?? Promise.resolve())),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              state.outcome = "timeout";
              resolve();
            }, timeoutMs);
            signal?.addEventListener(
              "abort",
              () => {
                state.outcome = "aborted";
                resolve();
              },
              { once: true },
            );
          }),
        ]);
        if (timer) clearTimeout(timer);
        return {
          content: [
            {
              type: "text",
              text: `${
                state.outcome === "timeout"
                  ? `Wait timed out after ${formatDuration(timeoutMs)}. The runs below keep going.`
                  : state.outcome === "aborted"
                    ? "Wait cancelled. The runs below keep going."
                    : `All ${records.length} run${records.length === 1 ? "" : "s"} finished; output below.`
              }\n\n${records
                .map((r) =>
                  r.progress.status === "running"
                    ? formatRunLine(r)
                    : `${formatRunLine(r)}\n${runPayload(r.id, transcriptOf(r))}`,
                )
                .concat(
                  interrupted.map(
                    (r) =>
                      `${r.id}  [interrupted]  ${r.agent}\n${INTERRUPTED_ERROR}`,
                  ),
                )
                .join("\n\n")}`,
            },
          ],
          details: undefined,
          structuredContent: manageValue({
            outcome: state.outcome,
            runs: [
              ...records.map((r) => runValue(r.progress)),
              ...interrupted.map(interruptedValue),
            ],
          }),
        };
      }

      if (!id) {
        return fail(
          `subagent_manage: 'id' is required for action '${action}'. The id was printed by the subagent call that started the run.`,
        );
      }

      if (action === "result") {
        const blocks: string[] = [];
        const values: Static<typeof RunValueSchema>[] = [];
        for (const runId of id
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          const run = runsStore.get(runId);
          if (!run) {
            if (resultStore.has(runId)) {
              blocks.push(`${runId}\n${runPayload(runId, "", fieldPath)}`);
              values.push({
                id: runId,
                agent: "",
                status: "done",
                output: "",
                result: getByPath(resultStore.get(runId), fieldPath),
              });
              continue;
            }
            const lost = interruptedRuns.get(runId);
            if (lost) {
              blocks.push(
                `${runId}  [interrupted]  ${lost.agent}\n${INTERRUPTED_ERROR}`,
              );
              values.push(interruptedValue(lost));
              continue;
            }
            return fail(`subagent_manage: no tracked run with id "${runId}"`);
          }
          if (run.progress.status === "running") {
            return fail(
              `subagent_manage: run "${runId}" is still running. Call action 'wait' instead: it blocks and returns the output.`,
            );
          }
          blocks.push(
            `${formatRunLine(run)}\n${runPayload(run.id, transcriptOf(run), fieldPath)}`,
          );
          values.push(runValue(run.progress, fieldPath));
        }
        return {
          content: [{ type: "text", text: blocks.join("\n\n") }],
          details: undefined,
          structuredContent: manageValue({ runs: values }),
        };
      }

      const record = runsStore.get(id);
      if (!record) {
        return fail(`subagent_manage: no tracked run with id "${id}"`);
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
          structuredContent: manageValue({ runs: [runValue(record.progress)] }),
        };
      }
      if (record.progress.status !== "running" || !record.paneId) {
        return fail(
          `subagent_manage: run "${id}" is not running, cannot steer.`,
        );
      }
      if (!message) {
        return fail(
          "subagent_manage: 'message' is required for action 'steer'.",
        );
      }
      // The child's editor would run a leading / as a command and ! as bash.
      if (/^\s*[/!]/.test(message)) {
        return fail(
          "subagent_manage: a steer message must not start with '/' or '!'. Rephrase it as plain text.",
        );
      }
      // Bracketed paste keeps newlines as text. Typed with send-keys, the
      // first newline would submit a partial message.
      const buffer = `pi-steer-${id}`;
      if (!(
        (await tmuxRun(["set-buffer", "-b", buffer, "--", message])) &&
        (await tmuxRun([
          "paste-buffer",
          "-p",
          "-d",
          "-b",
          buffer,
          "-t",
          record.paneId,
        ]))
      )) {
        return fail(`subagent_manage: tmux could not paste into run "${id}".`);
      }
      await tmuxRun(["send-keys", "-t", record.paneId, "Enter"]);
      return {
        content: [
          {
            type: "text",
            text: `sent to subagent '${record.progress.agent}' (${id}).`,
          },
        ],
        details: undefined,
        structuredContent: manageValue({ runs: [runValue(record.progress)] }),
      };
    },
  });
}
