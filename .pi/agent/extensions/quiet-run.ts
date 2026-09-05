// quiet-run — runs a shell command with its output kept out of context.
//
// Replaces bg-run. That tool's real win was output landing in a log file
// instead of the transcript; backgrounding was incidental, and the job id +
// status tool it needed turned every long command into a sleep-poll loop that
// burned turns to learn "still running". Here there is no id and no status
// tool: the call blocks, the log stays on disk, and the model gets one compact
// verdict line plus the slice it asked for.
//
// Live output still reaches the user through onUpdate (TUI-only, never in
// context), so a 10-minute build is watchable without being readable by the
// model.

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  formatSize,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exposeRegisteredToolsToEval } from "./shared/bridge-tools";

const DEFAULT_TAIL_LINES = 20;
const MAX_TAIL_LINES = 200;
// A test suite or build can write hundreds of MB; only the newest slice is
// ever worth re-reading, and the exact line count comes from the live stream.
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const UPDATE_INTERVAL_MS = 200;
const LIVE_TAIL_LINES = 12;
const SIGKILL_GRACE_MS = 3_000;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// A log outlives its verdict by a session at most, so every *.log here expires
// on age — including strays from the retired bg-run tool, which used the same
// directory and would otherwise sit in repos forever.
function pruneOldLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    for (const name of fs.readdirSync(logDir)) {
      if (!name.endsWith(".log")) continue;
      const p = path.join(logDir, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    /* best effort */
  }
}

function readLogTail(logPath: string): string {
  const size = fs.statSync(logPath).size;
  if (size <= MAX_SCAN_BYTES) return fs.readFileSync(logPath, "utf8");
  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(MAX_SCAN_BYTES);
    fs.readSync(fd, buf, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// pi's own limits, so a quiet_run result is capped exactly like a bash result.
// Only the body is truncated: the verdict line names the log path, and a
// whole-result tail cut would drop it.
function capBody(body: string): string {
  const r = truncateTail(body);
  if (!r.truncated) return body;
  const limit =
    r.truncatedBy === "lines" ? `${r.maxLines} lines` : formatSize(r.maxBytes);
  return `[... truncated to the last ${limit} of ${formatSize(r.totalBytes)} ...]\n${r.content}`;
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);

  pi.registerTool({
    name: "quiet_run",
    label: "Quiet Run",
    description:
      "Run a noisy shell command with its output kept out of context: it lands in a log file, the result is one verdict line (exit, duration, line count, log path) plus the tail or `filter` matches. " +
      "First choice for builds, test suites, installs, migrations. " +
      "WRONG: bash `npm test`, thousands of lines in context. RIGHT: quiet_run `npm test`, then grep the log path if the tail was not enough.",
    promptSnippet:
      "Build, test suite, install, or any command that prints hundreds of lines to say one thing: quiet_run.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
      tail: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: MAX_TAIL_LINES,
          description: `Output lines to return. Default ${DEFAULT_TAIL_LINES}; 0 for the verdict line alone.`,
        }),
      ),
      filter: Type.Optional(
        Type.String({
          description:
            "Case-insensitive regex, e.g. 'error|failed'. Returns matching lines (with a count) instead of the tail.",
        }),
      ),
    }),
    async execute(_callId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const tailLines = params.tail ?? DEFAULT_TAIL_LINES;
      let matcher: RegExp | undefined;
      if (params.filter) {
        try {
          matcher = new RegExp(params.filter, "i");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text", text: `quiet_run: bad filter regex — ${msg}` },
            ],
            details: {},
            error: msg,
          };
        }
      }

      const logDir = path.join(cwd, ".pi", "tasks");
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {
        /* spawn below surfaces the real error if cwd is unusable */
      }
      pruneOldLogs(logDir);
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const logPath = path.join(logDir, `${id}.log`);

      const startedAt = Date.now();
      let child: ChildProcess;
      let logFd: number;
      try {
        logFd = fs.openSync(logPath, "a");
        child = spawn(params.command, {
          shell: true,
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group so a timeout/abort reaches the whole tree:
          // signalling just the shell leaves `sleep`/test workers alive and
          // their inherited pipes open, which stalls this call until they
          // finish on their own.
          detached: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `quiet_run: failed to start — ${msg}` },
          ],
          details: { logPath },
          error: msg,
        };
      }

      let lineCount = 0;
      let pending = "";
      const liveTail: string[] = [];
      let lastPush = 0;
      const pushLive = (force = false) => {
        const now = Date.now();
        if (!force && now - lastPush < UPDATE_INTERVAL_MS) return;
        lastPush = now;
        try {
          onUpdate?.({
            content: [
              {
                type: "text" as const,
                text: `${formatDuration(now - startedAt)} · ${lineCount} lines\n${liveTail.join("\n")}`,
              },
            ],
            details: { logPath, lineCount },
          });
        } catch {
          /* renderer errors must not kill the run */
        }
      };

      const ingest = (chunk: Buffer) => {
        try {
          fs.writeSync(logFd, chunk);
        } catch {
          /* disk trouble — the live counters still work */
        }
        pending += chunk.toString("utf8");
        let idx = pending.indexOf("\n");
        while (idx !== -1) {
          liveTail.push(pending.slice(0, idx));
          if (liveTail.length > LIVE_TAIL_LINES) liveTail.shift();
          lineCount++;
          pending = pending.slice(idx + 1);
          idx = pending.indexOf("\n");
        }
        pushLive();
      };
      child.stdout?.on("data", ingest);
      child.stderr?.on("data", ingest);

      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* already gone */
        }
      };
      const terminate = () => {
        killTree("SIGTERM");
        sigkillTimer ??= setTimeout(
          () => killTree("SIGKILL"),
          SIGKILL_GRACE_MS,
        );
      };

      let timedOut = false;
      const timer = params.timeoutSeconds
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, params.timeoutSeconds * 1000)
        : undefined;
      signal?.addEventListener("abort", terminate, { once: true });

      const { code, killSignal } = await new Promise<{
        code: number | null;
        killSignal: NodeJS.Signals | null;
      }>((resolve) => {
        child.on("error", () => resolve({ code: null, killSignal: null }));
        child.on("close", (c, s) => resolve({ code: c, killSignal: s }));
      });

      if (timer) clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      signal?.removeEventListener("abort", terminate);
      if (pending) {
        try {
          fs.writeSync(logFd, Buffer.from(pending, "utf8"));
        } catch {
          /* ignore */
        }
        lineCount++;
      }
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      pushLive(true);

      const duration = formatDuration(Date.now() - startedAt);
      const verdict = timedOut
        ? `timeout after ${params.timeoutSeconds}s`
        : signal?.aborted
          ? "aborted"
          : killSignal
            ? `killed (${killSignal})`
            : `exit=${code ?? "?"}`;
      const head = `${verdict} · ${duration} · ${lineCount} lines · ${logPath}`;

      let raw = "";
      try {
        raw = readLogTail(logPath);
      } catch {
        /* fall through to the head-only report */
      }
      const all = raw.split("\n");
      if (all.at(-1) === "") all.pop();
      // Oversized logs are scanned from the tail only, so "of N" has to name
      // what was actually searched rather than the full line count.
      const scope =
        all.length < lineCount ? `${all.length} scanned` : `${lineCount}`;

      let body: string;
      if (all.length === 0) {
        body = "(no output)";
      } else if (matcher) {
        const hits = all.filter((l) => matcher.test(l));
        const shown = tailLines > 0 ? hits.slice(-tailLines) : [];
        body =
          hits.length === 0
            ? `0 of ${scope} lines match /${params.filter}/i`
            : `${hits.length} of ${scope} lines match /${params.filter}/i${hits.length > shown.length ? `, last ${shown.length}` : ""}:\n${shown.join("\n")}`;
      } else if (tailLines === 0) {
        body = "";
      } else {
        const shown = all.slice(-tailLines);
        body =
          all.length > shown.length
            ? `last ${shown.length} of ${scope} lines:\n${shown.join("\n")}`
            : shown.join("\n");
      }

      const text = body ? `${head}\n${capBody(body)}` : head;
      const failed = timedOut || killSignal !== null || (code ?? 1) !== 0;
      return {
        content: [{ type: "text", text }],
        details: { logPath, exitCode: code, lineCount, timedOut },
        ...(failed ? { error: verdict } : {}),
      };
    },
  });
}
