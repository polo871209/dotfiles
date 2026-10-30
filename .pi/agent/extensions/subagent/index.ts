import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lastAssistantText } from "../shared/message";
import { surviveReload } from "../shared/reload";
import { WORKING_FRAME_MS, workingFrames } from "../shared/working-indicator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyText,
  parseFrontmatter,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
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
  packs: string[];
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

interface Activity {
  callId: string;
  tool: string;
  summary: string;
  since: number;
}

interface Progress {
  id?: string;
  agent: string;
  task: string;
  model: string;
  status: "running" | "done" | "failed";
  background: boolean;
  startedAt: number;
  durationMs: number;
  activity?: Activity;
  stalled?: boolean;
  output: string;
  error?: string;
}

interface RunRecord {
  id: string;
  sessionId: string;
  blockId?: string;
  resultFile?: string;
  controller: AbortController;
  progress: Progress;
  settled?: Promise<void>;
  delivered?: boolean;
  stopped?: boolean;
  stallReportedFor?: string;
  detach?: () => void;
  redrawRow?: () => void;
}

const STALL_MS = 5 * 60_000;
const DETACH_KEY = "ctrl+alt+b";
const NOTICE_BATCH_MS = 1_000;
const NOTICE_TYPE = "subagent-notice";

interface Notice {
  kind: "done" | "stall";
  progress: Progress;
  stall?: string;
}

const delivery = surviveReload(
  "__piSubagentDelivery",
  (): {
    waiting: Map<string, number>;
    attentionListeners: Set<(runId: string, stall: string) => void>;
    pending: { kind: Notice["kind"]; record: RunRecord; stall?: string }[];
    timer?: ReturnType<typeof setTimeout>;
  } => ({
    waiting: new Map(),
    attentionListeners: new Set(),
    pending: [],
  }),
);

const activityFileOf = (resultFile: string) => `${resultFile}.activity`;

const stallText = (activity: Activity): string =>
  `${activity.tool} open for ${formatDuration(Date.now() - activity.since)}${activity.summary ? `: ${activity.summary}` : ""}`;
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
    notify?: (content: string, notices: Notice[], triggerTurn: boolean) => void;
    userAborted?: boolean;
  } => ({}),
);

const isWaitedOn = (runId: string) => (delivery.waiting.get(runId) ?? 0) > 0;

const stallNoticeText = (record: RunRecord, stall: string): string =>
  `subagent '${record.progress.agent}' (${record.id}) has had ${stall}. It can be legitimately slow. To intervene, call subagent_manage with action steer or stop.`;

const doneNoticeText = (record: RunRecord): string =>
  `${formatRunLine(record)}\n${runPayload(record.id, transcriptOf(record))}`;

function flushNotices(): void {
  delivery.timer = undefined;
  const pending = delivery.pending
    .splice(0)
    .filter(
      ({ kind, record }) =>
        record.sessionId === sink.sessionId &&
        (kind === "done"
          ? !record.delivered && !isWaitedOn(record.id)
          : record.progress.status === "running"),
    );
  if (pending.length === 0) return;
  for (const { kind, record } of pending)
    if (kind === "done") record.delivered = true;
  const finished = pending.filter(({ kind }) => kind === "done").length;
  const header =
    finished === pending.length
      ? `${finished} background subagent run${finished === 1 ? "" : "s"} finished.`
      : "Background subagent update.";
  try {
    sink.notify?.(
      `${header}\n\n${pending.map(({ record, stall }) => (stall ? stallNoticeText(record, stall) : doneNoticeText(record))).join("\n\n")}`,
      pending.map(({ kind, record, stall }) => ({
        kind,
        progress: { ...record.progress },
        ...(stall ? { stall } : {}),
      })),
      !sink.userAborted,
    );
  } catch {}
}

function queueNotice(
  kind: Notice["kind"],
  record: RunRecord,
  stall?: string,
): void {
  if (!record.progress.background || record.stopped) return;
  if (isWaitedOn(record.id) || record.sessionId !== sink.sessionId) return;
  delivery.pending.push({ kind, record, stall });
  delivery.timer ??= setTimeout(flushNotices, NOTICE_BATCH_MS);
}

function reportStall(record: RunRecord, activity: Activity): void {
  if (!record.progress.background) return;
  const stall = stallText(activity);
  for (const listener of delivery.attentionListeners)
    listener(record.id, stall);
  queueNotice("stall", record, stall);
}

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

function capReturnedOutput(text: string, id: string): string {
  const capBytes = 8 * 1024;
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= capBytes) return text;
  const head = Buffer.from(text, "utf-8")
    .subarray(0, capBytes)
    .toString("utf-8");
  const shown = head.slice(0, Math.max(head.lastIndexOf("\n"), 0)) || head;
  const file = path.join(os.tmpdir(), `pi-subagent-output-${id}.md`);
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch (err) {
    return `${shown}\n\n[output cut at ${capBytes / 1024} KB of ${Math.ceil(bytes / 1024)} KB, and the full text could not be saved: ${String(err)}]`;
  }
  const shownLines = shown.split("\n").length;
  return `${shown}\n\n[output cut at line ${shownLines} of ${text.split("\n").length}. The full ${Math.ceil(bytes / 1024)} KB is at ${file}. Read it with offset ${shownLines + 1} for the rest.]`;
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
        Type.Literal("attention"),
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
const DEFAULT_MAX_DURATION_MS = 3_600_000;
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_MAX_DURATION_MS + 60_000;

const REX_SCRIPT = path.join(import.meta.dirname, "rex.lua");

function rexScript<T>(
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "rex",
      ["do", REX_SCRIPT, "--args", JSON.stringify(args)],
      { signal: options.signal, stdio: ["ignore", "pipe", "pipe"] },
    );
    let result: unknown;
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        result = JSON.parse(line);
      } catch {
        child.kill();
        reject(new Error(`rex do printed non-JSON output: ${line}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(result as T);
      else reject(new Error(stderr.trim() || `rex do exited with ${code}`));
    });
  });
}

let panelChain: Promise<unknown> = Promise.resolve();

function withPanelLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = panelChain.then(fn, fn);
  panelChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const closePanes = (blockIds: string[], files: string[] = []) =>
  withPanelLock(() =>
    rexScript({ op: "close", block_ids: blockIds, files }),
  ).catch(() => undefined);

const listField = (value: unknown): string[] =>
  (typeof value === "string" ? value : "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
      tools: listField(frontmatter.tools),
      packs: listField(frontmatter.packs),
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
  if (p.status === "running" && p.background) return theme.fg("muted", "•");
  if (p.status === "running") {
    const frames = workingFrames(theme);
    return frames[Math.floor(Date.now() / WORKING_FRAME_MS) % frames.length]!;
  }
  if (p.status === "failed") return theme.fg("error", "✗");
  return theme.fg("success", "✓");
};

const pendingProgress = (args: Partial<SubagentArgs>): Progress => ({
  agent: args.agent ?? "",
  task: args.task ?? "",
  model: "",
  status: "running",
  background: args.background === true,
  startedAt: 0,
  durationMs: 0,
  output: "",
});

const renderProgressComponent = (
  p: Progress,
  theme: Theme,
  width: number,
  expanded: boolean,
) => {
  const c = new Container();
  const running = p.status === "running";
  const starting = p.startedAt === 0;
  const facts = [
    p.model.split("/").at(-1) ?? "",
    starting
      ? "starting"
      : running && p.background
        ? "in background"
        : formatDuration(p.durationMs),
  ].filter(Boolean);
  const activity =
    running && p.activity
      ? ` · ${theme.fg(p.stalled ? "warning" : "dim", stallText(p.activity))}`
      : "";
  c.addChild(
    new Text(
      fitLine(
        `${statusIcon(theme, p)} ${theme.fg("toolTitle", theme.bold(p.agent))} ${theme.fg("dim", facts.join(" · "))}${activity}`,
        width,
      ),
      0,
      0,
    ),
  );
  const task = p.task.trim().split("\n", 1)[0] ?? "";
  if (task)
    c.addChild(new Text(fitLine(theme.fg("dim", `  ${task}`), width), 0, 0));
  if (running && !p.background && !starting)
    c.addChild(
      new Text(theme.fg("dim", `  ${DETACH_KEY} to move to background`), 0, 0),
    );

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
  background: boolean,
): Progress => ({
  agent: agent.name,
  task,
  model,
  status: "running",
  background,
  startedAt: Date.now(),
  durationMs: 0,
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
          "wait: block until the given runs (or all running ones) finish or one needs attention, then return each one's output. result: re-read a finished run's output later. steer: send follow-up text into the run. stop: abort the run.",
      },
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Run id as printed by the subagent call. Required for result, steer, stop. wait and result take a comma-separated list. For wait, omit it to cover every running run.",
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
          'result only: dot path into captured result-json, e.g. "findings.0.path". Omit it for the whole object.',
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
  return `${r.id}  [${p.status}]  ${p.agent}  ${formatDuration(
    p.status === "running" ? Date.now() - p.startedAt : p.durationMs,
  )}${p.status === "running" && p.activity ? `  — ${stallText(p.activity)}` : ""}${p.error ? `  — ${p.error}` : ""}`;
};

const runPayload = (
  id: string,
  transcript: string,
  fieldPath?: string,
): string => {
  if (resultStore.has(id)) {
    const value = getByPath(resultStore.get(id), fieldPath);
    if (value === undefined)
      return `(no field "${fieldPath}" in the result-json of ${id})`;
    return headTruncate(JSON.stringify(value, null, 2), MAX_OUTPUT_BYTES);
  }
  return transcript || "(no output)";
};

const transcriptOf = (r: RunRecord): string =>
  r.progress.output || r.progress.error || "";

type WatchOutcome = {
  state: "done" | "error" | "blocked" | "timeout" | "closed";
  msg?: string;
  output?: string;
};

function readActivity(file: string): Activity | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Activity;
  } catch {
    return undefined;
  }
}

function tick(record: RunRecord, activityFile: string): void {
  const { progress } = record;
  progress.durationMs = Date.now() - progress.startedAt;
  progress.activity = readActivity(activityFile);
  progress.stalled =
    progress.activity !== undefined &&
    Date.now() - progress.activity.since >= STALL_MS;
  if (
    progress.stalled &&
    progress.activity &&
    record.stallReportedFor !== progress.activity.callId
  ) {
    record.stallReportedFor = progress.activity.callId;
    reportStall(record, progress.activity);
  }
}

async function runInRex(
  agent: AgentConfig,
  task: string,
  model: string | undefined,
  thinking: string | undefined,
  cwd: string,
  record: RunRecord,
  trusted: boolean,
  onTick: () => void,
): Promise<{
  content: { type: "text"; text: string }[];
  details: Progress;
  isError?: boolean;
}> {
  const { progress, id: target } = record;
  const { signal } = record.controller;
  const resultFile = path.join(os.tmpdir(), `pi-subagent-result-${target}.txt`);
  const activityFile = activityFileOf(resultFile);
  record.resultFile = resultFile;
  const command = [
    "env",
    "PI_IS_SUBAGENT=1",
    `PI_SUBAGENT_RESULT_FILE=${resultFile}`,
    ...(agent.packs.length > 0
      ? [`PI_SKILL_PACKS=${agent.packs.join(",")}`]
      : []),
    "pi",
    "--no-session",
    "--no-mcp",
    "--no-skills",
    ...(agent.appendPrompt
      ? ["--append-system-prompt", agent.appendPrompt]
      : []),
    trusted ? "--approve" : "--no-approve",
    ...(agent.tools.length > 0 ? ["--tools", agent.tools.join(",")] : []),
    "--exclude-tools",
    "ask_user_question",
    ...(model ? ["--model", model] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    "--",
    // pi reads a leading @ as a file to attach and a leading / as a command.
    /^[@/]/.test(task) ? ` ${task}` : task,
  ];
  const fail = (error: string, text = `subagent '${agent.name}' ${error}`) => {
    progress.status = "failed";
    progress.error = error;
    return {
      content: [{ type: "text" as const, text }],
      details: { ...progress },
      isError: true,
    };
  };

  let blockId: string;
  try {
    ({ block_id: blockId } = await withPanelLock(() =>
      rexScript<{ block_id: string }>({
        op: "open",
        label: target,
        cwd,
        command,
      }),
    ));
  } catch (err) {
    return fail(`failed — could not open a Rex pane: ${String(err)}`);
  }
  record.blockId = blockId;

  const ticker = setInterval(() => {
    tick(record, activityFile);
    onTick();
  }, WORKING_FRAME_MS);
  const stopTicking = () => {
    clearInterval(ticker);
    progress.activity = undefined;
    progress.stalled = undefined;
  };
  const childFiles = [activityFile, `${activityFile}.tmp`];
  let outcome: WatchOutcome;
  try {
    outcome = await rexScript<WatchOutcome>(
      {
        op: "watch",
        block_id: blockId,
        result_file: resultFile,
        timeout: DEFAULT_MAX_DURATION_MS / 1000,
      },
      { signal },
    );
  } catch (err) {
    stopTicking();
    progress.durationMs = Date.now() - progress.startedAt;
    await closePanes([blockId], [resultFile, ...childFiles]);
    return fail(
      signal.aborted
        ? "aborted by parent"
        : `lost the Rex pane: ${String(err)}`,
    );
  } finally {
    stopTicking();
  }
  progress.durationMs = Date.now() - progress.startedAt;

  if (outcome.state === "timeout") {
    await closePanes([blockId], [resultFile, ...childFiles]);
    return fail(
      `timed out after ${formatDuration(DEFAULT_MAX_DURATION_MS)} (wall clock)`,
    );
  }

  const extracted = extractResultBlock((outcome.output ?? "").trim(), target);
  let finalText = capReturnedOutput(extracted.text, target);
  if (extracted.captured) {
    finalText += `\n\n[result-json cached as ${target}. Read it later with subagent_manage (action: result).]`;
  }
  progress.output = finalText;

  if (outcome.state === "blocked") {
    return fail(
      "subagent pane is blocked — needs manual attention (left open for review)",
      `subagent '${agent.name}' is blocked in Rex pane ${target} — check it directly.\n${finalText}`,
    );
  }

  await closePanes([blockId], childFiles);
  if (outcome.state === "error") {
    return fail(
      `failed: ${outcome.msg ?? "the run stopped on an error"}`,
      `subagent '${agent.name}' failed: ${outcome.msg ?? "the run stopped on an error"}\n${finalText}`,
    );
  }
  if (outcome.state === "closed" && !finalText) {
    return fail("pane closed before the run finished");
  }
  progress.status = "done";
  return {
    content: [{ type: "text", text: finalText }],
    details: { ...progress },
  };
}

const describeCall = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim())
      return value.trim().split("\n", 1)[0]!.slice(0, 80);
  }
  return "";
};

function registerChildReporter(pi: ExtensionAPI): void {
  const file = process.env.PI_SUBAGENT_RESULT_FILE;
  if (!file) return;
  const activityFile = activityFileOf(file);
  const openCalls = new Map<string, Activity>();
  const writeActivity = () => {
    const oldest = openCalls.values().next().value;
    try {
      if (!oldest) {
        fs.rmSync(activityFile, { force: true });
        return;
      }
      fs.writeFileSync(`${activityFile}.tmp`, JSON.stringify(oldest), {
        mode: 0o600,
      });
      fs.renameSync(`${activityFile}.tmp`, activityFile);
    } catch {}
  };
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId) return;
    openCalls.set(event.toolCallId, {
      callId: event.toolCallId,
      tool: event.toolName,
      summary: describeCall(event.args),
      since: Date.now(),
    });
    writeActivity();
  });
  pi.on("tool_execution_end", (event) => {
    if (openCalls.delete(event.toolCallId)) writeActivity();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const branch = ctx.sessionManager.getBranch();
      const lastReply = branch
        .flatMap((e) =>
          e.type === "message" && e.message.role === "assistant"
            ? [e.message]
            : [],
        )
        .at(-1);
      const output = lastAssistantText(branch);
      const result: Omit<WatchOutcome, "state"> & { state: "done" | "error" } =
        lastReply?.stopReason === "error"
          ? {
              state: "error",
              msg: lastReply.errorMessage?.split("\n", 1)[0],
              output,
            }
          : { state: "done", output };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {}
  });
}

// Rex marks a pane with any status record as unread, so the child keeps a root record only while `blocked`, which rex.lua watches for.
function hideRunStateFromRex(): void {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (write as (...args: unknown[]) => boolean)(
      typeof chunk === "string"
        ? chunk.replace(
            /\x1b\]7501;state=(?:idle|working|done|error)\b/g,
            "\x1b]7501;state=clear",
          )
        : chunk,
      ...rest,
    )) as typeof process.stdout.write;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") {
    hideRunStateFromRex();
    registerChildReporter(pi);
    return;
  }
  if (!process.env.REX_BLOCK) return;

  sink.append = (type, data) => pi.appendEntry(type, data);
  sink.notify = (content, notices, triggerTurn) =>
    pi.sendMessage<Notice[]>(
      { customType: NOTICE_TYPE, content, display: true, details: notices },
      { triggerTurn, deliverAs: "steer" },
    );
  pi.on("agent_start", () => {
    sink.userAborted = false;
  });
  pi.on("agent_settled", (event) => {
    sink.userAborted = event.aborted;
  });
  pi.registerMessageRenderer<Notice[]>(
    NOTICE_TYPE,
    (message, options, theme) => ({
      render: (width: number) => {
        const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
        for (const notice of message.details ?? [])
          box.addChild(
            notice.stall
              ? new Text(
                  `${theme.fg("warning", "\u26a0")} ${theme.fg("toolTitle", theme.bold(notice.progress.agent))} ${theme.fg("warning", notice.stall)}`,
                  0,
                  0,
                )
              : renderProgressComponent(
                  notice.progress,
                  theme,
                  width - 2,
                  options.expanded,
                ),
          );
        return box.render(width);
      },
      invalidate: () => {},
    }),
  );
  pi.registerShortcut(DETACH_KEY, {
    description: "Move running foreground subagents to the background",
    handler: (ctx) => {
      const detachable = [...runsStore.values()].filter(
        (record) => record.detach !== undefined,
      );
      if (detachable.length === 0) {
        ctx.ui.notify("No foreground subagent is running", "info");
        return;
      }
      for (const record of detachable) record.detach?.();
    },
  });
  persistResult = (id, value) => {
    const sessionId = runsStore.get(id)?.sessionId;
    if (sessionId) persist(sessionId, RESULT_ENTRY_TYPE, { id, value });
  };
  pi.on("session_start", async (event, ctx) => {
    sink.sessionId = ctx.sessionManager.getSessionId();
    sink.userAborted = false;
    if (event.reason !== "startup" && event.reason !== "reload")
      resultStore.clear();
    hydrateResultStore(ctx.sessionManager.getBranch());
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    const running = [...runsStore.values()].filter(
      (record) => record.progress.status === "running",
    );
    for (const record of running) record.controller.abort();
    const blockIds = running.flatMap((record) => record.blockId ?? []);
    if (blockIds.length === 0) return;
    try {
      execFileSync(
        "rex",
        [
          "do",
          REX_SCRIPT,
          "--args",
          JSON.stringify({
            op: "close",
            block_ids: blockIds,
            files: running.flatMap((record) =>
              record.resultFile
                ? [record.resultFile, activityFileOf(record.resultFile)]
                : [],
            ),
          }),
        ],
        { timeout: 5_000 },
      );
    } catch {}
  });

  const agents = loadAgents();
  if (agents.length === 0) return;

  const params = buildParams(agents);

  pi.registerTool<typeof params, Progress | undefined>({
    name: "subagent",
    label: "Subagent",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
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
      "A background run's result arrives as a message when it finishes, so end the turn when nothing else is left to do.\n\n" +
      "For a compact hand-back, tell the subagent to end with a fenced ```result-json ... ``` block: the result returns it, and subagent_manage (action: result, path) pulls one field.",
    parameters: params,
    outputSchema: RunValueSchema,
    renderShell: "self",

    renderCall(args, theme, context) {
      if (context.executionStarted)
        return { render: () => [], invalidate() {} };
      const p = pendingProgress(args as Partial<SubagentArgs>);
      return {
        render: (width: number) =>
          renderProgressComponent(p, theme, width - 2, false).render(width),
        invalidate: () => {},
      };
    },

    renderResult(result, options, theme, context) {
      const record = result.details?.id
        ? runsStore.get(result.details.id)
        : undefined;
      if (record?.progress.background) record.redrawRow = context.invalidate;
      const p = record?.progress.background
        ? record.progress
        : (result.details ??
          pendingProgress(context.args as Partial<SubagentArgs>));
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
      const agent = agents.find((a) => a.name === args.agent)!;
      const registered = pi.getAllTools().map((tool) => tool.name);
      const unknownTools = agent.tools.filter((entry) => {
        const pattern = new RegExp(
          `^${entry
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        );
        return !registered.some((name) => pattern.test(name));
      });
      if (unknownTools.length > 0)
        throw new Error(
          `agent '${agent.name}' lists tools that no extension registers: ${unknownTools.join(", ")}. Fix the tools line of this agent in ${AGENTS_DIR}.`,
        );
      const commands = new Set(pi.getCommands().map((c) => c.name));
      const unknownPacks = agent.packs.filter((pack) => !commands.has(pack));
      if (unknownPacks.length > 0)
        throw new Error(
          `agent '${agent.name}' lists skill packs that no extension registers: ${unknownPacks.join(", ")}. Fix the packs line of this agent in ${AGENTS_DIR}.`,
        );
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
      const progress = initialProgress(
        agent,
        args.task,
        model ?? "default",
        args.background === true,
      );
      progress.id = target;

      const controller = new AbortController();
      const abortWithParent = () => controller.abort();
      if (signal && !args.background) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", abortWithParent, { once: true });
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

      const runPromise = runInRex(
        agent,
        args.task,
        model,
        agent.thinking ?? pi.getThinkingLevel(),
        ctx.cwd,
        record,
        ctx.isProjectTrusted(),
        () => {
          if (progress.background) record.redrawRow?.();
          else onUpdate?.({ content: [], details: { ...progress } });
        },
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
        )
        .then(() => {
          record.redrawRow?.();
          queueNotice("done", record);
        });

      const backgroundReceipt = (how: string) => ({
        content: [
          {
            type: "text" as const,
            text: `subagent '${agent.name}' ${how}, id ${target}. Its result arrives as a message when it finishes. Carry on with other work, or end the turn if nothing is left. Call subagent_manage (action: wait) only when your next step needs the result sooner.`,
          },
        ],
        details: { ...progress },
        structuredContent: runValue(progress),
      });

      if (args.background) return backgroundReceipt("running in background");

      const detached = new Promise<"detached">((resolve) => {
        record.detach = () => {
          record.detach = undefined;
          record.stallReportedFor = undefined;
          progress.background = true;
          signal?.removeEventListener("abort", abortWithParent);
          resolve("detached");
        };
      });
      const finished = await Promise.race([runPromise, detached]);
      record.detach = undefined;
      if (finished === "detached")
        return backgroundReceipt("was moved to the background by the user");
      return { ...finished, structuredContent: runValue(progress) };
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
      "Inspect or control background subagent runs started this session. A foreground run already returned its output, and a background run's output arrives as a message when it finishes, so neither needs a call here.\n\n" +
      "WRONG: sleep in a shell, or call wait or result for output a message already delivered. Each spends a turn on information you already have.\n" +
      "RIGHT: keep working or end the turn. Call wait only when your next step needs a background result before its message arrives.",
    parameters: manageParams(),
    outputSchema: ManageValueSchema,
    async execute(_toolCallId, rawParams, signal) {
      const {
        action,
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
        const deliveredBefore = new Set(
          records.filter((r) => r.delivered).map((r) => r.id),
        );
        for (const r of records)
          delivery.waiting.set(r.id, (delivery.waiting.get(r.id) ?? 0) + 1);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let onAttention: ((runId: string, stall: string) => void) | undefined;
        let needsAttention: { record: RunRecord; stall: string } | undefined;
        const outcome = await Promise.race([
          Promise.all(records.map((r) => r.settled ?? Promise.resolve())).then(
            () => "finished" as const,
          ),
          new Promise<"timeout" | "aborted" | "attention">((resolve) => {
            if (signal?.aborted) return resolve("aborted");
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
            onAbort = () => resolve("aborted");
            signal?.addEventListener("abort", onAbort, { once: true });
            onAttention = (runId, stall) => {
              const record = records.find((r) => r.id === runId);
              if (!record) return;
              needsAttention = { record, stall };
              resolve("attention");
            };
            delivery.attentionListeners.add(onAttention);
          }),
        ]);
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        if (onAttention) delivery.attentionListeners.delete(onAttention);
        for (const r of records) {
          const count = (delivery.waiting.get(r.id) ?? 1) - 1;
          if (count > 0) delivery.waiting.set(r.id, count);
          else delivery.waiting.delete(r.id);
          if (r.progress.status !== "running") r.delivered = true;
        }
        return {
          content: [
            {
              type: "text",
              text: `${
                outcome === "timeout"
                  ? `Wait timed out after ${formatDuration(timeoutMs)}. The runs below keep going.`
                  : outcome === "aborted"
                    ? "Wait cancelled. The runs below keep going."
                    : outcome === "attention" && needsAttention
                      ? stallNoticeText(
                          needsAttention.record,
                          needsAttention.stall,
                        )
                      : `All ${records.length} run${records.length === 1 ? "" : "s"} finished; output below.`
              }\n\n${records
                .map((r) =>
                  r.progress.status === "running"
                    ? formatRunLine(r)
                    : deliveredBefore.has(r.id)
                      ? `${formatRunLine(r)}\n(output already delivered in a subagent message)`
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
            outcome,
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
        record.stopped = true;
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
      if (record.progress.status !== "running" || !record.blockId) {
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
      try {
        await rexScript({
          op: "steer",
          block_id: record.blockId,
          text: message,
        });
      } catch (err) {
        return fail(
          `subagent_manage: Rex could not paste into run "${id}": ${String(err)}`,
        );
      }
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
