import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatDuration } from "./shared/format";

const SUCCESS_TAIL = 10;
const FAILURE_TAIL = 30;
// 100 lines of this width stay under pi's 50KB tool-result cap.
const MAX_LINE_CHARS = 300;

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
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(j - i > 1 ? `${lines[i]}  (×${j - i})` : lines[i]!);
    i = j;
  }
  return out;
}

const shell = createLocalBashOperations();

const verdictOf = (error: unknown, timeoutSeconds?: number) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "aborted") return "aborted";
  if (message.startsWith("timeout:")) return `timeout after ${timeoutSeconds}s`;
  return `failed to start (${message})`;
};

export default function (pi: ExtensionAPI) {
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
      "Default tool for shell commands. Returns a verdict line (exit, duration, line count) plus the last lines or the `filter` matches, and keeps the rest in a log file that the verdict names. " +
      "Use bash instead only when you need the full output of a short command, such as `git diff`. " +
      "WRONG: bash `npm test`, thousands of lines in context. RIGHT: quiet_run `npm test`.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Kill the command after this many seconds. Default: no limit.",
        }),
      ),
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
        description: "exit=N, timeout, aborted, or failed to start",
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
      const keep = params.tail ?? FAILURE_TAIL;
      // pi previews the first 10 lines of a partial result: 1 header + 9.
      const LIVE_LINES = 9;
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

      const decoder = new StringDecoder("utf8");
      const onData = (data: Buffer) => {
        const parts = (pending + decoder.write(data)).split("\n");
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
      };

      let code: number | null = null;
      let verdict: string;
      try {
        ({ exitCode: code } = await shell.exec(command, cwd, {
          onData,
          signal,
          timeout: params.timeoutSeconds,
        }));
        verdict = `exit=${code}`;
      } catch (error) {
        verdict = verdictOf(error, params.timeoutSeconds);
      }
      pending += decoder.end();
      if (pending) addLines([pending]);
      fs.closeSync(logFd);

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
          exit_code: code,
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
