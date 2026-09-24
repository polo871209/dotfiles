// quiet-run: runs a shell command with its output kept in a log file, so the
// model reads one verdict line plus the slice it asks for.
//
// The call blocks on purpose. A job id plus a status tool turned every long
// command into a sleep-poll loop that burned turns to learn "still running".
// Live output reaches the TUI through onUpdate and never enters context.
//
// Destructive gate (scoreDestructive): before spawning, TypeSafe's Jev model
// scores the command against the repo's git state, same endpoint and
// fail-open contract as web-search's rerank. At or above DESTRUCTIVE_FLOOR the
// user must approve in a dialog, and with no UI the call is refused. Measured
// 2026-01 on 50 labeled commands in fixture repos (clean, dirty, no git):
// reads, builds, tests, installs, and deleting ignored output scored
// 0.02-0.57; lost work, pushes, publishes, deploys, and writes outside cwd
// scored 0.75-0.99. Three safe commands still get a dialog: `find -delete` on
// ignored logs 0.71, `rm -rf` on committed clean `src` 0.75, and
// `git reset --hard` on a clean tree 0.82. Local Docker removals and prunes
// score 0.08-0.51, and Docker against a remote host or registry 0.82-0.96.
// Re-measure before moving the floor.

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { exposeRegisteredToolsToEval } from "./shared/bridge-tools";

const SUCCESS_TAIL = 10;
const FAILURE_TAIL = 30;
// 100 lines of this width stay under pi's 50KB tool-result cap.
const MAX_LINE_CHARS = 300;
const DESTRUCTIVE_FLOOR = 0.65;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

// A log is worth re-reading for a session at most.
function pruneOldLogs(logDir: string): void {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(logDir)) {
      const p = path.join(logDir, name);
      if (name.endsWith(".log") && fs.statSync(p).mtimeMs < cutoff)
        fs.unlinkSync(p);
    }
  } catch {
    /* best effort */
  }
}

// Terminal semantics, roughly: a progress bar redraws with \r, and only the
// last frame is what a human would have seen.
function cleanLine(raw: string): string {
  const line = raw.replace(/\r+$/, "");
  return stripVTControlCharacters(line.slice(line.lastIndexOf("\r") + 1));
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}… [+${line.length - MAX_LINE_CHARS} chars]`
    : line;
}

// Installers and test runners repeat one line many times in a row.
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

const execFileAsync = promisify(execFile);

// Git decides what a delete costs: a committed, clean file comes back with
// `git checkout`, an untracked one is gone. Jev judged by folder name alone,
// so an untracked `build/` of sources scored 0.20. Null outside a repo, on
// error, or past 2s in a huge repo, and the gate then assumes no git copy.
async function gitState(cwd: string): Promise<object | null> {
  const git = async (args: string[]) =>
    (await execFileAsync("git", args, { cwd, timeout: 2_000 })).stdout;
  try {
    const [root, status] = await Promise.all([
      git(["rev-parse", "--show-toplevel"]),
      git(["status", "--porcelain=v1", "--branch", "--ignored"]),
    ]);
    const [head = "", ...entries] = status.split("\n").filter(Boolean);
    const paths: Record<string, string> = {};
    for (const entry of entries.slice(0, 40)) {
      const code = entry.slice(0, 2);
      paths[entry.slice(3)] =
        code === "??"
          ? "untracked"
          : code === "!!"
            ? "ignored"
            : "uncommitted changes";
    }
    return {
      root: root.trim(),
      branch: head.slice(3),
      paths,
      ...(entries.length > 40 ? { unlistedPaths: entries.length - 40 } : {}),
    };
  } catch {
    return null;
  }
}

// Returns the probability that the command is destructive, or null when no
// key is set or the call fails in any way. Null means "run it": without the
// gate, quiet_run is no riskier than the bash tool.
export async function scoreDestructive(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const git = await gitState(cwd);
  try {
    // Median latency is ~0.8s; past this the gate gives up and the command runs.
    const timeout = AbortSignal.timeout(5_000);
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: { cwd, command, ...(git ? { git } : {}) },
        questions: {
          destructive: {
            type: "noul",
            instructions:
              "Is the shell command in `command` destructive? `git.paths` lists the paths under `git.root` that are untracked, ignored, or have uncommitted changes, and any other path there is committed and clean unless `git.unlistedPaths` is set. If `git` is absent, no file has a copy in git.",
            criteria: {
              true: "Running it can lose data that has no other copy, or change state beyond this machine: it deletes or overwrites untracked files, files with uncommitted changes, ignored files that no build or install regenerates, or files outside `cwd`; rewrites or discards git history or uncommitted work; pushes, publishes, deploys, or migrates; writes to a database, cluster, or cloud account; runs Docker against a remote host through `--context`, `-H`, or `DOCKER_HOST`; or pipes a remote script into a shell.",
              false:
                "It only reads, builds, tests, lints, formats, installs dependencies, or commits locally, or it deletes or overwrites only committed files with no uncommitted changes, which git restores, or ignored build output, dependency folders, caches, or logs, which a build or install regenerates; or it builds, runs, stops, removes, or prunes containers, images, volumes, or networks on the local Docker daemon, even with `-v` or `--volumes`, because the user accepts losing local Docker state.",
            },
          },
        },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      answers?: { destructive?: { noul?: number } };
    };
    const noul = payload.answers?.destructive?.noul;
    return typeof noul === "number" ? noul : null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);

  pi.registerTool({
    name: "quiet_run",
    label: "Quiet Run",
    description:
      "Default tool for shell commands. Runs the command with its output kept out of context and returns one verdict line (exit, duration, line count) plus the last lines, or the `filter` matches with line numbers. " +
      "The verdict names the log file only when output was left out; read it with offset or grep it. " +
      "A command judged destructive runs only after the user approves it. " +
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
    // TUI only. The command already sits in context as the call's arguments.
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

      onUpdate?.({
        content: [{ type: "text", text: "checking command with Jev…" }],
        details: {},
      });
      const risk = await scoreDestructive(command, cwd, signal);
      if (risk !== null && risk >= DESTRUCTIVE_FLOOR) {
        const score = risk.toFixed(2);
        const approved =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            `Destructive command (Jev ${score})`,
            `${command}\n\ncwd: ${cwd}\n\nRun it?`,
          ));
        if (!approved) {
          const why = ctx.hasUI
            ? "the user declined to run it"
            : "no user is present to approve it";
          // Name the bash side door, or the model walks through it.
          throw new Error(
            `quiet_run: blocked. Jev scored the command destructive (${score}) and ${why}. Do not run it through bash or another tool. Show the command to the user and wait for their decision.`,
          );
        }
      }

      const logDir = path.join(cwd, ".pi", "tasks");
      fs.mkdirSync(logDir, { recursive: true });
      pruneOldLogs(logDir);
      const logPath = path.join(
        logDir,
        `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`,
      );
      const logFd = fs.openSync(logPath, "w");

      const startedAt = Date.now();
      // `exec 2>&1` merges stderr at the fd level, so lines keep the order the
      // command wrote them in.
      const child = spawn("/bin/sh", ["-c", `exec 2>&1\n${command}`], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        // Own process group so a timeout or abort reaches the whole tree:
        // signalling only the shell leaves workers alive holding the pipe open.
        detached: true,
      });

      // Output is kept only as far as the result can show it, so a 500MB log
      // costs no memory and needs no read-back.
      const keep = params.tail ?? FAILURE_TAIL;
      const ringSize = Math.max(keep, 12); // 12 = live TUI view
      const ring: string[] = [];
      const hits: string[] = [];
      let hitCount = 0;
      let lineCount = 0;
      let pending = "";
      let lastPush = 0;

      const addLines = (raws: string[]) => {
        const clean = raws.map(cleanLine);
        for (const line of clean) {
          lineCount++;
          ring.push(line);
          if (ring.length > ringSize) ring.shift();
          if (matcher?.test(line)) {
            hitCount++;
            hits.push(`${lineCount}: ${line}`);
            if (hits.length > keep) hits.shift();
          }
        }
        try {
          fs.writeSync(logFd, `${clean.join("\n")}\n`);
        } catch {
          /* disk trouble: the in-memory result still works */
        }
      };

      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        const parts = (pending + chunk).split("\n");
        pending = parts.pop()!;
        // A \r-only progress bar never ends its line; keep its newest frame
        // so pending stays small. A trailing \r can be half of \r\n.
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
                text: `${formatDuration(now - startedAt)} · ${lineCount} lines\n${ring.slice(-12).join("\n")}`,
              },
            ],
            details: {},
          });
        } catch {
          /* renderer errors must not kill the run */
        }
      });

      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          /* already gone */
        }
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

      const { code, killSignal, spawnError } = await new Promise<{
        code: number | null;
        killSignal: NodeJS.Signals | null;
        spawnError?: Error;
      }>((resolve) => {
        child.on("error", (err) =>
          resolve({ code: null, killSignal: null, spawnError: err }),
        );
        child.on("close", (c, s) => resolve({ code: c, killSignal: s }));
      });
      clearTimeout(timer);
      clearTimeout(sigkillTimer);
      signal?.removeEventListener("abort", terminate);
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
      const source = matcher ? hits : ring;
      const shown = n > 0 ? source.slice(-n) : [];

      const body = matcher
        ? [
            `${hitCount} of ${lineCount} lines match /${params.filter}/i${shown.length < hitCount ? `, last ${shown.length}` : ""}`,
            ...shown.map(clip),
          ]
        : collapseRuns(shown).map(clip);
      const hidden =
        shown.length < lineCount ||
        shown.some((l) => l.length > MAX_LINE_CHARS);
      // A log whose every line is already in the result has no reader.
      if (!hidden) fs.rmSync(logPath, { force: true });

      const head = [
        verdict,
        formatDuration(Date.now() - startedAt),
        lineCount === 0
          ? "no output"
          : `${lineCount} line${lineCount === 1 ? "" : "s"}`,
        ...(hidden ? [`log ${path.relative(cwd, logPath)}`] : []),
      ].join(" · ");
      const text = [head, ...body].join("\n");
      // Throwing is how pi marks a result failed, same as the bash tool.
      if (failed) throw new Error(text);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
