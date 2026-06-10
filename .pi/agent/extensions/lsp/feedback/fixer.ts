// LLM auto-fixer: feed a file + its diagnostics to a side-channel completion,
// take back the full corrected file, write it if it passes safety checks.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { sideChannelComplete } from "../../shared/llm";
import { MAX_FILE_BYTES } from "./driver";
import type { Diag, Severity } from "./types";

const MAX_FIX_FILES = 5;

export const FIXABLE_SEVERITIES: ReadonlySet<Severity> = new Set([
  "error",
  "warn",
  "info",
  "hint",
]);

const FIXER_SYSTEM = `Fix only the listed LSP/lint issues in the file. Change nothing else; preserve all other code, comments, and formatting exactly. Fix the root cause — don't suppress a diagnostic with an ignore/disable directive (\`---@diagnostic\`, \`@ts-ignore\`, \`# noqa\`, etc.). If you can't genuinely resolve an issue, leave it as-is so it stays reported. Output the full corrected file in one fenced code block. No prose.`;

const groupFixableByFile = (diags: Diag[]): Map<string, Diag[]> => {
  const m = new Map<string, Diag[]>();
  for (const d of diags) {
    if (!FIXABLE_SEVERITIES.has(d.severity)) continue;
    const arr = m.get(d.file) ?? [];
    arr.push(d);
    m.set(d.file, arr);
  }
  return m;
};

// Require a fenced code block. Bare prose is rejected — too easy for a
// short "no issues found" reply to clobber the source file.
const extractCodeBlock = (text: string): string | null => {
  const m = text.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  return m ? m[1]! : null;
};

const countChar = (s: string, c: string) => s.split(c).length - 1;

// Guard against truncated/garbled LLM output clobbering a working file.
// `=== original` is a legit "nothing to fix" reply, so it passes (the caller
// skips writing it). null / <90% length / unbalanced braces|parens fail.
const isSafeFix = (original: string, fixed: string | null): fixed is string => {
  if (fixed === null) return false;
  if (fixed === original) return true;
  if (fixed.length < original.length * 0.9) return false;
  return (
    countChar(fixed, "{") === countChar(original, "{") &&
    countChar(fixed, "}") === countChar(original, "}") &&
    countChar(fixed, "(") === countChar(original, "(") &&
    countChar(fixed, ")") === countChar(original, ")")
  );
};

const runFixerLLM = async (
  file: string,
  content: string,
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  const diagText = diags
    .map(
      (d) =>
        `${d.line}:${d.col}  ${d.source ? `${d.source}${d.code ? `(${d.code})` : ""}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");

  const userText = [
    `File: ${file}`,
    "",
    "Issues:",
    diagText,
    "",
    "```",
    content,
    "```",
  ].join("\n");

  const r = await sideChannelComplete(ctx, {
    systemPrompt: FIXER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: Date.now(),
      },
    ],
    signal,
  });
  if (!r.ok) return null;
  return extractCodeBlock(r.text);
};

// Returns the files written plus their pre-fix content (so the caller can diff
// old→new for the agent).
export const applyFixes = async (
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<{ file: string; before: string }[]> => {
  const targets = Array.from(groupFixableByFile(diags).entries()).slice(
    0,
    MAX_FIX_FILES,
  );
  const patched: { file: string; before: string }[] = [];

  for (const [file, errs] of targets) {
    let original: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      original = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let fixed = await runFixerLLM(file, original, errs, ctx, signal);
    // A truncated/unbalanced first response is often transient — retry once.
    if (!isSafeFix(original, fixed)) {
      fixed = await runFixerLLM(file, original, errs, ctx, signal);
    }
    if (!isSafeFix(original, fixed) || fixed === original) continue;
    try {
      // No backup — user has git. isSafeFix above (length floor, brace
      // balance, identity check) catches obvious bad outputs.
      fs.writeFileSync(file, fixed, "utf8");
      patched.push({ file, before: original });
    } catch {
      /* ignore */
    }
  }
  return patched;
};
