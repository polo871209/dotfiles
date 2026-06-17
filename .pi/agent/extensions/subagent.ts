// /subagent — delegate work to an isolated `pi` child process. Single-layer
// only: agents cannot spawn other subagents (PI_IS_SUBAGENT=1 in the child
// env makes this extension early-exit before registering its tool).
//
// Agents live in pi's standard agents dir (`~/.pi/agent/agents/*.md`) as
// markdown with YAML frontmatter:
//   ---
//   name: scout
//   description: ...
//   tools: read, grep, find, ls       # optional --tools allowlist
//   model: anthropic/claude-haiku-4-5  # optional
//   thinking: low                      # optional
//   idleTimeout: 120                   # optional, seconds (stall watchdog)
//   maxDuration: 600                   # optional, seconds (wall-clock cap)
//   ---
//   <system prompt body>
//
// Child is invoked with `--mode json -p` so we receive a structured event
// stream (tool_execution_start/end, message_end) and can render a live TUI
// while the agent works.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
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
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractText } from "./shared/message";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: string;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  systemPrompt: string;
}

interface ToolEvent {
  toolCallId: string;
  name: string;
  argsPreview: string;
  status: "running" | "done";
}

interface Progress {
  agent: string;
  task: string;
  model: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  durationMs: number;
  tools: ToolEvent[];
  lastMessage: string;
  output: string;
  error?: string;
}

const AGENTS_DIR = path.join(getAgentDir(), "agents");
// Off-by-default lifecycle tracing. Set PI_SUBAGENT_DEBUG=1 to append JSONL
// state transitions to the log below; inspect it after a stuck run to see which
// stall class fired (live-hang: no clean stop + child alive + a tool still
// running, vs. post-stop pipe-hold: cleanStopSeen + !childExited + pipes
// unended). No behavior change — purely observational.
const DEBUG = process.env.PI_SUBAGENT_DEBUG === "1";
const DEBUG_LOG = path.join(getAgentDir(), "logs", "subagent-debug.jsonl");
const HEARTBEAT_MS = 15_000;
const dbg = (fields: Record<string, unknown>): void => {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ t: new Date().toISOString(), ...fields }) + "\n",
    );
  } catch {
    /* logging is best-effort */
  }
};
const MAX_OUTPUT_BYTES = 32 * 1024;
const UPDATE_INTERVAL_MS = 150;
// 1s: the tick only refreshes the elapsed-time display; a faster cadence just
// repaints the widget for a cosmetic timer and adds flicker.
const TICK_INTERVAL_MS = 1000;
// A grandchild (nvim/kernel) can keep the child's stdio pipe open after the
// child exits, so the ChildProcess `close` event (process end + stdio closed)
// would never fire. We resolve only on `close`, and a post-exit stdio guard
// guarantees it: once the child exits, destroy the parent's unended pipe
// handles after STDIO_IDLE_MS of quiet (or the STDIO_HARD_MS cap for a chatty
// grandchild), which forces `close`.
const STDIO_IDLE_MS = 2000;
const STDIO_HARD_MS = 8000;
// A pi child can print its terminal assistant message yet linger without
// exiting. After a clean stop: grace, then SIGTERM → SIGKILL. A kill we issue
// here is success drainage, NOT a failure (see classification below).
const FINAL_STOP_GRACE_MS = 1000;
const FINAL_HARD_KILL_MS = 3000;
// Watchdogs for a child that hangs while still alive (the unhandled stall
// class). Two independent guards:
//   - idle: no JSON event AND no tool in flight for this long → a model/loop
//     stall. Gated on "no tool running" so a legitimately slow tool (a long
//     build/test emits start, then silence until end) is never false-killed.
//   - wall-clock: absolute cap that also catches a genuinely hung tool or a
//     runaway tool loop. Generous so real long agents finish.
// Both overridable per-agent via frontmatter (idleTimeout / maxDuration, secs).
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DURATION_MS = 600_000;
const ARG_PREVIEW_MAX = 60;
// Keep the live widget short: a tall component redrawn every tick flickers and
// buries the conversation. Cap visible tool rows (tail while running) and the
// echoed task.
const MAX_VISIBLE_TOOLS = 6;
const TASK_PREVIEW_MAX = 140;
const FORBIDDEN_TOOLS = new Set(["subagent"]);

// Signal the child's whole process GROUP, not just the child PID. The child
// `pi` spawns grandchildren (its own nvim, slow web fetches); if we only hit
// the child it can sit blocked in a grandchild and ignore SIGTERM, and a
// surviving grandchild keeps the stdio pipe open so `close` never fires.
// Killing the group (-pid, requires the child spawned `detached`) reaches the
// entire subtree at once. Falls back to a direct child kill if the group send
// fails (e.g. group already gone).
const trySignal = (
  child: { pid?: number; kill: (s: NodeJS.Signals) => boolean },
  sig: NodeJS.Signals,
): boolean => {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch {
      // group gone or not a leader — fall through to direct kill
    }
  }
  try {
    return child.kill(sig);
  } catch {
    return false;
  }
};

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
      idleTimeoutMs: secsToMs(frontmatter.idleTimeout),
      maxDurationMs: secsToMs(frontmatter.maxDuration),
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

// Collapse whitespace runs so a multi-line arg stays renderable on one line.
const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

// One-line preview of common tool args. Falls back to a flattened JSON dump.
const extractArgsPreview = (rawArgs: Record<string, unknown>): string => {
  const a = rawArgs;
  const cap = (s: string): string =>
    s.length > ARG_PREVIEW_MAX ? s.slice(0, ARG_PREVIEW_MAX - 1) + "…" : s;
  if (typeof a.command === "string") return cap(flatten(a.command));
  if (typeof a.pattern === "string") return cap(flatten(a.pattern));
  if (typeof a.query === "string") return `"${cap(flatten(a.query))}"`;
  if (typeof a.url === "string") return cap(flatten(a.url));
  if (typeof a.path === "string") return cap(flatten(a.path));
  if (typeof a.file === "string") {
    const sym = typeof a.symbol === "string" && a.symbol ? ` ${a.symbol}` : "";
    const line = typeof a.line === "number" ? `:${a.line}` : "";
    return cap(flatten(`${a.file}${line}${sym}`));
  }
  return cap(flatten(JSON.stringify(a)));
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

// Pluck the latest prose line from the assistant's text, skipping code blocks.
const proseLastLine = (text: string): string => {
  if (!text) return "";
  let inFence = false;
  let last = "";
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && raw.trim()) last = raw.trim();
  }
  return last;
};

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
  const stats = `${p.tools.length} tools · ${formatDuration(p.durationMs)}`;
  const model = theme.fg("dim", ` (${p.model})`);
  const header = `${icon} ${theme.fg("toolTitle", theme.bold(p.agent))}${model} ${theme.fg("dim", "—")} ${theme.fg("dim", stats)}`;
  c.addChild(new Text(fitLine(header, width), 0, 0));

  // While running, show only the tail of the tool list (header already carries
  // the total count). Once done, collapse the rows away unless expanded.
  if (p.status === "running" || expanded) {
    const start = expanded
      ? 0
      : Math.max(0, p.tools.length - MAX_VISIBLE_TOOLS);
    if (start > 0) {
      c.addChild(new Text(theme.fg("dim", `  … ${start} earlier`), 0, 0));
    }
    for (let i = start; i < p.tools.length; i++) {
      const t = p.tools[i]!;
      const body = t.argsPreview ? `${t.name} ${t.argsPreview}` : t.name;
      const row =
        t.status === "running"
          ? theme.fg("warning", `  ▸ ${body}`)
          : theme.fg("muted", `  ✓ ${body}`);
      c.addChild(new Text(fitLine(row, width), 0, 0));
    }
  }

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
  tools: [],
  lastMessage: "",
  output: "",
});

export default function (pi: ExtensionAPI) {
  if (process.env.PI_IS_SUBAGENT === "1") return;

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
      `Delegate a task to a specialized subagent running in an isolated process. ` +
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
          details: { ...progress, tools: [...progress.tools] },
        });
      };
      const push = throttle(pushNow, UPDATE_INTERVAL_MS);

      // Periodic tick: refresh the duration display and run the watchdogs.
      const onTick = () => {
        push();
        if (childExited || watchdogReason) return;
        const now = Date.now();
        if (now - progress.startedAt > maxMs) {
          fireWatchdog("timeout");
        } else if (
          !progress.tools.some((t) => t.status === "running") &&
          now - lastEventAt > idleMs
        ) {
          fireWatchdog("idle");
        }
      };
      const tick = setInterval(onTick, TICK_INTERVAL_MS);

      // Heartbeat trace: when the child goes quiet, record how long it's been
      // idle and what tool (if any) is still running — this is the fingerprint
      // of a live-hang. Off unless PI_SUBAGENT_DEBUG=1.
      const heartbeat = DEBUG
        ? setInterval(() => {
            if (childExited) return;
            const running = progress.tools
              .filter((t) => t.status === "running")
              .map((t) => `${t.name} ${t.argsPreview}`);
            log("heartbeat", {
              idleMs: Date.now() - lastEventAt,
              running,
              cleanStopSeen,
            });
          }, HEARTBEAT_MS)
        : undefined;
      heartbeat?.unref?.();

      const piArgs = [
        "-p",
        args.task,
        "--mode",
        "json",
        "--no-session",
        "--no-context-files",
        "--system-prompt",
        agent.systemPrompt,
      ];
      if (agent.tools.length > 0) {
        const expanded = expandToolPatterns(
          agent.tools,
          pi.getAllTools().map((t) => t.name),
        );
        if (expanded.length > 0) piArgs.push("--tools", expanded.join(","));
      }
      if (agent.model) piArgs.push("--model", agent.model);
      if (agent.thinking) piArgs.push("--thinking", agent.thinking);

      const child = spawn("pi", piArgs, {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // New process group so we can SIGTERM/SIGKILL the whole subtree (child
        // + its grandchildren) via trySignal's `-pid`. Abort is handled
        // manually below so we can escalate SIGTERM → SIGKILL; spawn's own
        // `signal` only sends one SIGTERM to the child PID alone.
        // POSIX-only: bare `spawn("pi")` and `process.kill(-pid)` don't work on
        // Windows (pi is a .cmd shim; negative PIDs are unsupported). For a
        // Windows-portable spawn see nicobailon/pi-subagents `getPiSpawnCommand`
        // (resolves the node CLI script instead of the shim).
        detached: true,
        env: { ...process.env, PI_IS_SUBAGENT: "1" },
      });

      const log = (phase: string, extra?: Record<string, unknown>) =>
        dbg({
          agent: agent.name,
          pid: child.pid,
          phase,
          sinceStartMs: Date.now() - progress.startedAt,
          ...extra,
        });
      log("spawn", { piArgs });

      let outBuf = "";
      let stderrBuf = "";
      let childExited = false;
      let lastEventAt = Date.now(); // any JSON event from the child
      let cleanStopSeen = false; // terminal assistant stop, no error/tool call
      let assistantError = ""; // provider/agent error surfaced in a message
      let forcedTermination = false; // we SIGTERM/SIGKILL'd a lingering child
      let aborted = false; // parent AbortSignal fired
      let watchdogReason = ""; // "idle" | "timeout" once a watchdog kills it

      const idleMs = agent.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const maxMs = agent.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

      // Kill a child that is alive but stalled. Not a clean stop, so this is a
      // genuine failure — we still surface whatever partial output was captured.
      const fireWatchdog = (reason: "idle" | "timeout") => {
        if (childExited || watchdogReason) return;
        watchdogReason = reason;
        log("watchdog", { reason, idleMs, maxMs });
        forcedTermination = trySignal(child, "SIGTERM") || forcedTermination;
        const t = setTimeout(() => {
          if (!childExited)
            forcedTermination =
              trySignal(child, "SIGKILL") || forcedTermination;
        }, FINAL_HARD_KILL_MS);
        t.unref?.();
      };

      // Post-stop drain: the child can print its final message yet linger.
      let finalDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let finalHardKillTimer: ReturnType<typeof setTimeout> | undefined;
      const clearFinalDrain = () => {
        if (finalDrainTimer) clearTimeout(finalDrainTimer);
        if (finalHardKillTimer) clearTimeout(finalHardKillTimer);
        finalDrainTimer = finalHardKillTimer = undefined;
      };
      const startFinalDrain = () => {
        if (childExited || finalDrainTimer) return;
        finalDrainTimer = setTimeout(() => {
          if (childExited) return;
          forcedTermination = trySignal(child, "SIGTERM") || forcedTermination;
          finalHardKillTimer = setTimeout(() => {
            if (childExited) return;
            forcedTermination =
              trySignal(child, "SIGKILL") || forcedTermination;
          }, FINAL_HARD_KILL_MS);
          finalHardKillTimer.unref?.();
        }, FINAL_STOP_GRACE_MS);
        finalDrainTimer.unref?.();
      };

      // Post-exit stdio guard: once the child exits, force its (maybe
      // grandchild-held) pipes closed so `close` fires. Tracks `end` so a
      // clean exit isn't delayed.
      let stdoutEnded = false;
      let stderrEnded = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const clearStdioGuard = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
        idleTimer = hardTimer = undefined;
      };
      const destroyUnended = () => {
        if (!stdoutEnded) child.stdout?.destroy();
        if (!stderrEnded) child.stderr?.destroy();
      };
      const armIdle = () => {
        if (!childExited) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(destroyUnended, STDIO_IDLE_MS);
        idleTimer.unref?.();
      };
      child.stdout.on("end", () => {
        stdoutEnded = true;
        log("stdout_end", { childExited });
        if (stderrEnded) clearStdioGuard();
      });
      child.stderr.on("end", () => {
        stderrEnded = true;
        log("stderr_end", { childExited });
        if (stdoutEnded) clearStdioGuard();
      });

      // Parent abort: SIGTERM, then SIGKILL if the child ignores it.
      const onAbort = () => {
        if (childExited) return;
        aborted = true;
        log("abort");
        trySignal(child, "SIGTERM");
        const t = setTimeout(() => {
          if (!childExited) trySignal(child, "SIGKILL");
        }, FINAL_HARD_KILL_MS);
        t.unref?.();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      const handleEvent = (ev: { type?: string; [k: string]: unknown }) => {
        if (!ev || !ev.type) return;
        lastEventAt = Date.now();
        switch (ev.type) {
          case "tool_execution_start": {
            const id = String(ev.toolCallId ?? "");
            progress.tools.push({
              toolCallId: id,
              name: String(ev.toolName ?? "?"),
              argsPreview: extractArgsPreview(
                (ev.args as Record<string, unknown>) ?? {},
              ),
              status: "running",
            });
            push();
            break;
          }
          case "tool_execution_end": {
            const id = String(ev.toolCallId ?? "");
            const hit = progress.tools.find((t) => t.toolCallId === id);
            if (hit) hit.status = "done";
            push();
            break;
          }
          case "message_end": {
            const msg = ev.message as
              | {
                  role?: string;
                  content?: unknown;
                  stopReason?: string;
                  errorMessage?: string;
                }
              | undefined;
            if (!msg || msg.role !== "assistant") break;
            const text = extractText(msg.content);
            if (text) {
              progress.output = text;
              const line = proseLastLine(text);
              if (line) progress.lastMessage = line;
            }
            if (msg.errorMessage) assistantError = String(msg.errorMessage);
            push();
            // Drain only on a genuine terminal stop — a stop carrying a tool
            // call still has work pending.
            const hasToolCall =
              Array.isArray(msg.content) &&
              msg.content.some(
                (p) => (p as { type?: string } | null)?.type === "toolCall",
              );
            if (msg.errorMessage)
              log("assistant_error", { error: assistantError });
            if (msg.stopReason === "stop") {
              log("stop", { hasToolCall, hasError: !!msg.errorMessage });
            }
            if (msg.stopReason === "stop" && !hasToolCall) {
              if (!msg.errorMessage) cleanStopSeen = true;
              startFinalDrain();
            }
            break;
          }
        }
      };

      child.stdout.on("data", (c: Buffer) => {
        outBuf += c.toString("utf-8");
        let i: number;
        while ((i = outBuf.indexOf("\n")) >= 0) {
          const line = outBuf.slice(0, i);
          outBuf = outBuf.slice(i + 1);
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            /* non-JSON line, ignore */
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        stderrBuf += c.toString("utf-8");
      });

      const { code, sig, spawnError } = await new Promise<{
        code: number | null;
        sig: NodeJS.Signals | null;
        spawnError: Error | null;
      }>((resolve) => {
        let settled = false;
        const settle = (r: {
          code: number | null;
          sig: NodeJS.Signals | null;
          spawnError: Error | null;
        }) => {
          if (settled) return;
          settled = true;
          clearFinalDrain();
          clearStdioGuard();
          resolve(r);
        };
        // Re-arm the idle countdown on each post-exit chunk so buffered final
        // output still flushes before the pipes are destroyed.
        child.stdout.on("data", armIdle);
        child.stderr.on("data", armIdle);
        child.on("exit", () => {
          childExited = true;
          log("exit", { stdoutEnded, stderrEnded });
          clearFinalDrain();
          armIdle();
          if (!hardTimer) {
            hardTimer = setTimeout(destroyUnended, STDIO_HARD_MS);
            hardTimer.unref?.();
          }
        });
        // `close` = process ended AND stdio closed: the only safe resolve.
        child.on("close", (c, s) => {
          log("close", { code: c, sig: s });
          settle({ code: c, sig: s, spawnError: null });
        });
        child.on("error", (err) =>
          settle({ code: null, sig: null, spawnError: err }),
        );
      });

      clearInterval(tick);
      if (heartbeat) clearInterval(heartbeat);
      progress.durationMs = Date.now() - progress.startedAt;

      // A SIGTERM/SIGKILL we issued to drain a lingering—but successful—child
      // is not a failure; only a parent abort or a real bad exit is.
      const drainedAfterStop =
        forcedTermination && cleanStopSeen && !assistantError;
      const failed =
        spawnError != null ||
        aborted ||
        watchdogReason !== "" ||
        (!drainedAfterStop && (sig != null || (code != null && code !== 0)));

      log("settle", {
        code,
        sig,
        spawnError: spawnError?.message,
        aborted,
        cleanStopSeen,
        forcedTermination,
        drainedAfterStop,
        failed,
      });

      if (failed) {
        progress.status = "failed";
        const lastTool = progress.tools.at(-1)?.name;
        progress.error = spawnError
          ? `spawn error: ${spawnError.message}`
          : aborted
            ? "aborted by parent"
            : assistantError
              ? assistantError
              : watchdogReason === "timeout"
                ? `timed out after ${formatDuration(maxMs)} (wall clock)`
                : watchdogReason === "idle"
                  ? `stalled — no activity for ${formatDuration(idleMs)}${lastTool ? ` (last tool: ${lastTool})` : ""}`
                  : sig
                    ? `killed by ${sig}`
                    : `exit ${code}`;
        const detail =
          stderrBuf.trim() || progress.output.trim() || "(no child output)";
        return {
          content: [
            {
              type: "text",
              text: `subagent '${agent.name}' failed — ${progress.error}\n${detail}`,
            },
          ],
          details: { ...progress, tools: [...progress.tools] },
          error: `Subagent ${agent.name}: ${progress.error}`,
        };
      }

      progress.status = "done";
      const finalText = headTruncate(progress.output.trim(), MAX_OUTPUT_BYTES);
      progress.output = finalText;
      return {
        content: [{ type: "text", text: finalText }],
        details: { ...progress, tools: [...progress.tools] },
      };
    },
  });
}
