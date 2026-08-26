// bg-run — deterministic background shell jobs: no LLM, no tmux, no
// subagent. Fills the gap subagent.ts deliberately doesn't cover: running a
// long/noisy command (test suite, build, dev server, migration) without
// blocking the turn, when there's no reasoning work to delegate — just a
// process to track. Spinning a full subagent pi for that would cost a model
// turn to do nothing but babysit a shell command, which is what
// extensions/AGENTS.md's "deterministic first" rule argues against.
//
// Not a port of npm:pi-background-tasks — same shape (spawn, track, tail
// output) reimplemented minimally: no footer dock, no EventBus, no
// hash-verified retrieval, no Fusion/delegate multi-agent tools. Those solve
// problems this harness doesn't have (subagent.ts already covers
// agent-shaped delegation with steer/stop/wait).
//
// Job lifetime is tied to this pi process, not a separate daemon: children
// are spawned attached (not detached/unref'd) so their exit always updates
// status while the session is open. If the session exits first, the child is
// killed with it — background here means "off the conversation turn", not
// "survives quitting pi". A dev server you want to outlive the session
// belongs in its own terminal/tmux pane, not here.
//
// No desktop notification on job exit — every job's every exit pinging
// regardless of duration or focus proved too noisy for what's meant to be a
// quiet background tool.
//
// Instead the job wakes pi itself: on exit the extension injects a followUp
// message carrying status + log tail, with triggerTurn so an idle agent
// starts a turn on it. So the agent fires bg_run and *ends its turn* — no
// sleep-poll loop burning turns to ask "done yet?", no wall-clock waste. The
// only jobs that don't wake anyone are ones killed via bg_kill (the agent
// asked, it already knows) and ones reaped by session_shutdown.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exposeRegisteredToolsToEval } from "./shared/bridge-tools";

interface Job {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed" | "killed" | "timeout";
  exitCode: number | null;
  child: ChildProcess;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Cleared by bg_kill: a kill the agent requested needs no wake-up. */
  wakeOnExit: boolean;
}

const MAX_TRACKED_JOBS = 50;
const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_LOG_TAIL_CHARS = 20_000;
// The wake message lands in context unprompted, so it carries a far smaller
// tail than an explicit bg_logs call the agent asked for.
const WAKE_TAIL_LINES = 40;
const WAKE_TAIL_CHARS = 4_000;

// Jobs reaped by session_shutdown must not wake an agent whose session is
// already tearing down.
let sessionShuttingDown = false;

// globalThis-backed like subagent.ts's runsStore: pi loads each extension in
// an isolated module graph, and a reload must not orphan jobs already running.
const jobsStore = (() => {
  const g = globalThis as unknown as { __piBgRunJobs?: Map<string, Job> };
  return (g.__piBgRunJobs ??= new Map());
})();

function pruneJobsStore(): void {
  if (jobsStore.size <= MAX_TRACKED_JOBS) return;
  const finished = [...jobsStore.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const j of finished) {
    if (jobsStore.size <= MAX_TRACKED_JOBS) break;
    jobsStore.delete(j.id);
  }
}

function newJobId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function tailLines(text: string, lines: number): string {
  const all = text.split("\n");
  const tail = all.slice(-lines).join("\n");
  return tail.length > MAX_LOG_TAIL_CHARS
    ? tail.slice(tail.length - MAX_LOG_TAIL_CHARS)
    : tail;
}

// Self-contained completion report: the agent gets this unprompted after its
// turn ended, so it carries enough (verdict, exit code, duration, tail) to
// act on without a follow-up bg_logs round-trip.
function wakeReport(j: Job): string {
  const verdict = j.status === "done" ? "finished" : j.status;
  const dur = formatDuration((j.endedAt ?? Date.now()) - j.startedAt);
  const head =
    `bg job '${j.name}' ${verdict} (${j.id}, exit=${j.exitCode ?? "?"}, ${dur}).` +
    ` Full log: ${j.logPath}`;
  let tail = "";
  try {
    const raw = fs.readFileSync(j.logPath, "utf-8");
    const cut = tailLines(raw, WAKE_TAIL_LINES);
    tail =
      cut.length > WAKE_TAIL_CHARS
        ? cut.slice(cut.length - WAKE_TAIL_CHARS)
        : cut;
  } catch {
    /* log unreadable — head alone still tells the agent what happened */
  }
  return tail.trim()
    ? `${head}\n\nlast ${WAKE_TAIL_LINES} lines:\n${tail.trim()}`
    : `${head}\n\n(no output)`;
}

function formatJobLine(j: Job): string {
  const dur = formatDuration((j.endedAt ?? Date.now()) - j.startedAt);
  const exit = j.exitCode === null ? "" : ` exit=${j.exitCode}`;
  return `${j.id}  [${j.status}]${exit}  ${j.name}  ${dur}  pid=${j.pid ?? "?"}  log=${j.logPath}`;
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);

  pi.on("session_shutdown", () => {
    sessionShuttingDown = true;
    for (const j of jobsStore.values()) {
      if (j.status === "running") {
        try {
          j.child.kill("SIGTERM");
        } catch {
          /* best effort */
        }
      }
      if (j.timeoutTimer) clearTimeout(j.timeoutTimer);
    }
  });

  pi.registerTool({
    name: "bg_run",
    label: "Background Run",
    description:
      "Start a shell command in the background and return immediately — no agent involved, for long/noisy deterministic commands (builds, test suites, dev servers, migrations) that need tracking, not reasoning. " +
      "On exit the job wakes you with its status and log tail, so end your turn after starting it. " +
      "WRONG: bg_run then sleep/bg_status in a loop waiting for it. RIGHT: bg_run, finish the turn, handle the completion message when it arrives. " +
      "bg_status/bg_logs are for inspecting a job mid-flight on the user's behalf; bg_kill stops one.",
    promptSnippet:
      "Long/noisy shell command needing no reasoning: bg_run, then end the turn — it wakes you on exit. Never sleep-poll it.",
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        description: "Shell command to run (via the user's shell).",
      }),
      name: Type.Optional(
        Type.String({ description: "Short label shown in job listings." }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to the session cwd.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Kill the job if it's still running after this many seconds.",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd;
      const name = params.name || params.command.slice(0, 60);
      const id = newJobId();
      const logDir = path.join(cwd, ".pi", "tasks");
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {
        /* fall through — spawn below will surface the real error if cwd is bad */
      }
      const logPath = path.join(logDir, `${id}.log`);
      const logFd = fs.openSync(logPath, "a");

      let child: ChildProcess;
      try {
        child = spawn(params.command, {
          shell: true,
          cwd,
          stdio: ["ignore", logFd, logFd],
        });
      } catch (err) {
        fs.closeSync(logFd);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `bg_run: failed to start — ${msg}` }],
          details: {},
          error: msg,
        };
      }
      fs.closeSync(logFd); // child holds its own fd copy from stdio

      const job: Job = {
        id,
        name,
        command: params.command,
        cwd,
        pid: child.pid,
        logPath,
        startedAt: Date.now(),
        status: "running",
        exitCode: null,
        child,
        wakeOnExit: true,
      };
      jobsStore.set(id, job);
      pruneJobsStore();

      child.on("exit", (code, signal) => {
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
        job.endedAt = Date.now();
        job.exitCode = code;
        if (job.status === "running") {
          job.status =
            signal === "SIGTERM" || signal === "SIGKILL"
              ? "killed"
              : code === 0
                ? "done"
                : "failed";
        }
        if (!job.wakeOnExit || sessionShuttingDown) return;
        // followUp + triggerTurn: queued behind a turn already in flight,
        // or starts one if the agent is idle — the wake that replaces
        // sleep-polling.
        pi.sendMessage(
          {
            customType: "bg-run-complete",
            content: wakeReport(job),
            display: true,
            details: { id: job.id, status: job.status, exitCode: job.exitCode },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      });

      if (params.timeoutSeconds) {
        job.timeoutTimer = setTimeout(() => {
          if (job.status !== "running") return;
          job.status = "timeout";
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }, params.timeoutSeconds * 1000);
      }

      return {
        content: [
          {
            type: "text",
            text: `started '${name}' (id: ${id}, pid: ${child.pid ?? "?"}). Log: ${logPath}`,
          },
        ],
        details: { id, pid: child.pid, logPath },
      };
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background Status",
    description:
      "Status of a bg_run job by id, or every tracked job when id is omitted.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Job id; omit to list all." }),
      ),
    }),
    async execute(_callId, params) {
      if (!params.id) {
        const jobs = [...jobsStore.values()].sort(
          (a, b) => b.startedAt - a.startedAt,
        );
        const text =
          jobs.length === 0
            ? "No background jobs tracked this session."
            : jobs.map(formatJobLine).join("\n");
        return { content: [{ type: "text", text }], details: {} };
      }
      const job = jobsStore.get(params.id);
      if (!job) {
        const msg = `bg_status: no tracked job with id "${params.id}"`;
        return {
          content: [{ type: "text", text: msg }],
          details: {},
          error: msg,
        };
      }
      return {
        content: [{ type: "text", text: formatJobLine(job) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "bg_logs",
    label: "Background Logs",
    description: "Tail the output log of a bg_run job.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from bg_run or bg_status." }),
      lines: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 5000,
          default: DEFAULT_LOG_TAIL_LINES,
        }),
      ),
    }),
    async execute(_callId, params) {
      const job = jobsStore.get(params.id);
      if (!job) {
        const msg = `bg_logs: no tracked job with id "${params.id}"`;
        return {
          content: [{ type: "text", text: msg }],
          details: {},
          error: msg,
        };
      }
      let text: string;
      try {
        text = fs.readFileSync(job.logPath, "utf-8");
      } catch (err) {
        const msg = `bg_logs: could not read log — ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: {},
          error: msg,
        };
      }
      const tail = tailLines(
        text,
        Math.floor(params.lines ?? DEFAULT_LOG_TAIL_LINES),
      );
      return {
        content: [
          {
            type: "text",
            text: `${formatJobLine(job)}\n\n${tail || "(no output yet)"}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Background Kill",
    description: "Stop a running bg_run job.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id to stop." }),
    }),
    async execute(_callId, params) {
      const job = jobsStore.get(params.id);
      if (!job) {
        const msg = `bg_kill: no tracked job with id "${params.id}"`;
        return {
          content: [{ type: "text", text: msg }],
          details: {},
          error: msg,
        };
      }
      if (job.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `bg_kill: '${job.id}' is already ${job.status}.`,
            },
          ],
          details: {},
        };
      }
      job.wakeOnExit = false;
      try {
        job.child.kill("SIGTERM");
      } catch (err) {
        const msg = `bg_kill: failed to signal pid ${job.pid} — ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: msg }],
          details: {},
          error: msg,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `sent SIGTERM to '${job.name}' (${job.id}, pid ${job.pid}).`,
          },
        ],
        details: {},
      };
    },
  });
}
