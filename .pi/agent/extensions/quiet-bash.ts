import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, isBashToolResult } from "@earendil-works/pi-coding-agent";

const SUCCESS_TAIL = 10;
const FAILURE_TAIL = 30;
const QUIET_CHARS = 4000;
const MAX_LINE_CHARS = 300;
const LOG_DIR = path.join(os.homedir(), ".cache", "pi-run");

function pruneOldLogs(): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  try {
    for (const name of fs.readdirSync(LOG_DIR)) {
      const p = path.join(LOG_DIR, name);

      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch {}
}

function writeLog(output: string): string {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const logPath = path.join(
    LOG_DIR,
    `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`,
  );

  fs.writeFileSync(logPath, output);

  return logPath;
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", pruneOldLogs);

  pi.on("tool_result", (event) => {
    if (!isBashToolResult(event) || event.parentToolCallId) return;
    const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");

    if (text.length <= QUIET_CHARS) return;

    const output = text.replace(/\n\n\[Showing (?:lines|last) [^\n]*Full output: [^\n]*\]/, "");
    const logPath = event.details?.fullOutputPath ?? writeLog(output);
    const lines = output.split("\n").map(cleanLine);
    const total = event.details?.truncation?.totalLines ?? lines.length;
    const shown = lines.slice(-(event.isError ? FAILURE_TAIL : SUCCESS_TAIL));

    return {
      content: [
        {
          type: "text",
          text: [
            `[last ${shown.length} of ${total} lines · full output: ${logPath}]`,
            ...collapseRuns(shown).map(clip),
          ].join("\n"),
        },
      ],
      structuredContent: event.structuredContent,
    };
  });
}
