// bg-run — deterministic background shell jobs: no LLM, no tmux, no
// subagent. Fills the gap subagent.ts deliberately doesn't cover: running a
// long/noisy command (test suite, build, dev server, migration) without
// blocking the turn, when there's no reasoning work to delegate — just a
// process to track. Spinning a full subagent pi for that would cost a model
// turn to do nothing but babysit a shell command, which is what
// extensions/AGENTS.md's "deterministic first" rule argues against.
//
// Not a port of npm:pi-background-tasks — same shape (spawn, track, tail
// output, notify on exit) reimplemented minimally: no footer dock, no
// EventBus, no hash-verified retrieval, no Fusion/delegate multi-agent
// tools. Those solve problems this harness doesn't have (subagent.ts already
// covers agent-shaped delegation with steer/stop/wait).
//
// Job lifetime is tied to this pi process, not a separate daemon: children
// are spawned attached (not detached/unref'd) so their exit always updates
// status and fires a notification while the session is open. If the session
// exits first, the child is killed with it — background here means
// "off the conversation turn", not "survives quitting pi". A dev server you
// want to outlive the session belongs in its own terminal/tmux pane, not here.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exposeRegisteredToolsToEval } from "./shared/bridge-tools";
import { notifyExternal } from "./notifier";

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
}

const IS_SUBAGENT = process.env.PI_IS_SUBAGENT === "1";
// Set once session_shutdown starts killing running jobs, so their resulting
// exit events don't fire a notification for a job nobody's waiting on—the
// session (and its notifier) is on its way out anyway.
let sessionShuttingDown = false;

const MAX_TRACKED_JOBS = 50;
const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_LOG_TAIL_CHARS = 20_000;

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
      "Start a shell command in the background and return immediately — no agent involved, for long/noisy deterministic commands (builds, test suites, dev servers, migrations) that need tracking, not reasoning. Poll with bg_status/bg_logs, stop with bg_kill; fires a desktop notification on completion.",
    promptSnippet:
      "Long/noisy shell command needing no reasoning: bg_run, then bg_status/bg_logs/bg_kill.",
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
        // A subagent's bg job finishing isn't the parent's turn ending —
        // notifying here would fire a desktop ping for work nobody at the
        // keyboard is waiting on (same rationale as notifier.ts's IS_SUBAGENT
        // guard). Same for a job reaped by session_shutdown — the session
        // (and whoever'd see the ping) is already gone.
        if (!IS_SUBAGENT && !sessionShuttingDown) {
          const verdict = job.status === "done" ? "finished" : job.status;
          void notifyExternal(
            `${job.name} ${verdict} (${formatDuration(job.endedAt - job.startedAt)})`,
            job.cwd,
          );
        }
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
