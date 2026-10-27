import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SUCCESS_TAIL = 10;
const FAILURE_TAIL = 30;
// 100 lines of this width stay under pi's 50KB tool-result cap.
const MAX_LINE_CHARS = 300;
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function pruneOldLogs(logDir: string): void {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(logDir)) {
      const p = path.join(logDir, name);
      if (name.endsWith(".log") && fs.statSync(p).mtimeMs < cutoff)
        fs.unlinkSync(p);
    }
  } catch {}
}

function cleanLine(raw: string): string {
  const line = raw.replace(/\r+$/, "");
  return stripVTControlCharacters(line.slice(line.lastIndexOf("\r") + 1));
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}… [+${line.length - MAX_LINE_CHARS} chars]`
    : line;
}

function collapseRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(j - i > 1 ? `${lines[i]}  (×${j - i})` : lines[i]!);
    i = j;
  }
  return out;
}

const liveGroups = new Set<number>();

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    for (const pid of liveGroups) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    }
    liveGroups.clear();
  });

  pi.registerTool({
    name: "quiet_run",
    label: "Quiet Run",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Default tool for shell commands. Runs the command with its output kept out of context and returns one verdict line (exit, duration, line count) plus the last lines, or the `filter` matches with line numbers. " +
      "The verdict names the log file only when output was left out; read it with offset or grep it. " +
      "Use bash instead only when you need the full output of a short command, such as `git diff`. " +
      "WRONG: bash `npm test`, thousands of lines in context. RIGHT: quiet_run `npm test`.",
    promptSnippet:
      "Build, test suite, install, or any command that prints hundreds of lines to say one thing: quiet_run.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
      tail: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 100,
          description: `Lines to return. Default ${SUCCESS_TAIL} on success, ${FAILURE_TAIL} on failure.`,
        }),
      ),
      filter: Type.Optional(
        Type.String({
          description:
            "Case-insensitive regex, e.g. 'error|failed'. Returns the last `tail` matching lines instead of the tail.",
        }),
      ),
    }),
    outputSchema: Type.Object({
      verdict: Type.String({
        description: "exit=N, timeout, aborted, or killed",
      }),
      exit_code: Type.Union([Type.Number(), Type.Null()]),
      duration_ms: Type.Number(),
      lines: Type.Number({ description: "Total output lines" }),
      output: Type.String({ description: "The tail or filter matches shown" }),
      log_path: Type.Optional(
        Type.String({ description: "Full log, when output was left out" }),
      ),
    }),
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const opts = [
        args.filter && `filter /${args.filter}/i`,
        args.tail !== undefined && `tail ${args.tail}`,
        args.timeoutSeconds && `timeout ${args.timeoutSeconds}s`,
      ].filter(Boolean);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("quiet_run"))} ${theme.fg("accent", `$ ${args.command ?? ""}`)}` +
          (opts.length ? theme.fg("dim", ` (${opts.join(" · ")})`) : ""),
      );
      return text;
    },

    async execute(_callId, params, signal, onUpdate, ctx) {
      const { command } = params;
      const cwd = ctx.cwd;
      const matcher = params.filter
        ? new RegExp(params.filter, "i")
        : undefined;

      if (signal?.aborted)
        throw new Error("quiet_run: aborted before the command started.");

      const logDir = path.join(cwd, ".pi", "tasks");
      fs.mkdirSync(logDir, { recursive: true });
      pruneOldLogs(logDir);
      const logPath = path.join(
        logDir,
        `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`,
      );
      const logFd = fs.openSync(logPath, "w");

      const startedAt = Date.now();
      const child = spawn("/bin/sh", ["-c", `exec 2>&1\n${command}`], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        // Own process group, because signalling only the shell leaves workers alive holding the pipe open.
        detached: true,
      });

      const keep = params.tail ?? FAILURE_TAIL;
      // pi previews the first 10 lines of a partial result: 1 header + 9.
      const LIVE_LINES = 9;
      const ring: string[] = [];
      const hits: string[] = [];
      let hitCount = 0;
      let lineCount = 0;
      let pending = "";
      let lastPush = 0;
      let lastData = Date.now();

      const addLines = (raws: string[]) => {
        const clean = raws.map(cleanLine);
        for (const line of clean) {
          lineCount++;
          ring.push(line);
          if (ring.length > Math.max(keep, LIVE_LINES)) ring.shift();
          if (matcher?.test(line)) {
            hitCount++;
            hits.push(`${lineCount}: ${line}`);
            if (hits.length > keep) hits.shift();
          }
        }
        try {
          fs.writeSync(logFd, `${clean.join("\n")}\n`);
        } catch {}
      };

      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        lastData = Date.now();
        const parts = (pending + chunk).split("\n");
        pending = parts.pop()!;
        const cr = pending.lastIndexOf("\r", pending.length - 2);
        if (cr > 0) pending = pending.slice(cr + 1);
        if (parts.length) addLines(parts);
        const now = Date.now();
        if (!onUpdate || now - lastPush < 200) return;
        lastPush = now;
        try {
          onUpdate({
            content: [
              {
                type: "text",
                text: `${formatDuration(now - startedAt)} · ${lineCount} lines\n${ring.slice(-LIVE_LINES).join("\n")}`,
              },
            ],
            details: {},
          });
        } catch {}
      });

      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {}
      };
      const terminate = () => {
        killTree("SIGTERM");
        sigkillTimer ??= setTimeout(() => killTree("SIGKILL"), 3_000);
      };
      let timedOut = false;
      const timer = params.timeoutSeconds
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, params.timeoutSeconds * 1000)
        : undefined;
      signal?.addEventListener("abort", terminate, { once: true });
      if (child.pid) liveGroups.add(child.pid);

      const { code, killSignal, spawnError } = await new Promise<{
        code: number | null;
        killSignal: NodeJS.Signals | null;
        spawnError?: Error;
      }>((resolve) => {
        child.on("error", (err) =>
          resolve({ code: null, killSignal: null, spawnError: err }),
        );
        child.on("close", (c, s) => resolve({ code: c, killSignal: s }));
        // A background job (`cmd &`) inherits the pipe and holds it open after the shell exits.
        child.on("exit", (c, s) => {
          const deadline = Date.now() + 2_000;
          const settle = () => {
            if (Date.now() - lastData < 100 && Date.now() < deadline) {
              setTimeout(settle, 100);
              return;
            }
            child.stdout!.destroy();
            resolve({ code: c, killSignal: s });
          };
          setTimeout(settle, 100);
        });
      });
      clearTimeout(timer);
      clearTimeout(sigkillTimer);
      signal?.removeEventListener("abort", terminate);
      if (child.pid) liveGroups.delete(child.pid);
      if (pending) addLines([pending]);
      fs.closeSync(logFd);

      const verdict = spawnError
        ? `failed to start (${spawnError.message})`
        : timedOut
          ? `timeout after ${params.timeoutSeconds}s`
          : signal?.aborted
            ? "aborted"
            : killSignal
              ? `killed (${killSignal})`
              : `exit=${code}`;
      const failed = verdict !== "exit=0";
      const n = params.tail ?? (failed ? FAILURE_TAIL : SUCCESS_TAIL);
      const shown = n > 0 ? (matcher ? hits : ring).slice(-n) : [];

      const body = matcher
        ? [
            `${hitCount} of ${lineCount} lines match /${params.filter}/i${shown.length < hitCount ? `, last ${shown.length}` : ""}`,
            ...shown.map(clip),
          ]
        : collapseRuns(shown).map(clip);
      const hidden =
        shown.length < lineCount ||
        shown.some((l) => l.length > MAX_LINE_CHARS);
      if (!hidden) fs.rmSync(logPath, { force: true });
      return {
        content: [
          {
            type: "text",
            text: [
              [
                verdict,
                formatDuration(Date.now() - startedAt),
                lineCount === 0
                  ? "no output"
                  : `${lineCount} line${lineCount === 1 ? "" : "s"}`,
                ...(hidden ? [`log ${path.relative(cwd, logPath)}`] : []),
              ].join(" · "),
              ...body,
            ].join("\n"),
          },
        ],
        details: {},
        structuredContent: {
          verdict,
          exit_code: spawnError || timedOut || killSignal ? null : code,
          duration_ms: Date.now() - startedAt,
          lines: lineCount,
          output: body.join("\n"),
          ...(hidden ? { log_path: logPath } : {}),
        },
        ...(failed ? { isError: true } : {}),
      };
    },
  });
}
