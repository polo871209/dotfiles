// LLM last-resort fixer: when deterministic LSP code-actions can't clear an
// error/warning, feed the file + its diagnostics to a side-channel completion,
// take back the full corrected file, and write it only if it passes safety
// checks. This is the ONLY non-deterministic step in the pipeline (see
// pipeline.ts); it never runs unless a real error/warning survived code-fix.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { sideChannelComplete } from "../../shared/llm";
import { MAX_FILE_BYTES } from "./driver";
import type { Diag, Severity } from "./types";

const MAX_FIX_FILES = 5;

// Only errors and warnings engage the LLM. Mechanical info/hint issues (unused
// imports, ordering, etc.) are left to the deterministic code-actions that ran
// first, or simply reported. Keeps the LLM focused on what actually needs
// reasoning and avoids it deleting "unused" code on a whim.
export const LLM_TARGET_SEVERITIES: ReadonlySet<Severity> = new Set([
  "error",
  "warn",
]);

const FIXER_SYSTEM = `You fix LSP/lint issues in a source file. Resolve EVERY listed issue at its root cause in ONE pass — work through them one by one, reason about what the code is trying to do, and infer missing imports, types, signatures, or fixes from how each symbol is used elsewhere in the file. Make the minimal real change that makes each diagnostic genuinely go away. Do NOT suppress with an ignore/disable directive (\`---@diagnostic\`, \`@ts-ignore\`, \`# noqa\`, etc.). Change nothing unrelated: preserve all other code, comments, and formatting exactly. Leave an issue unfixed if it truly cannot be resolved from this file alone, OR if it concerns a version pin or version mismatch (dependency/package/tool/language version, incompatible/outdated version, "requires version x", version constraint) — never touch versions. Output the full corrected file in one fenced code block. No prose.`;

// Group only the LLM-target diagnostics (error/warn) by file.
const groupTargetsByFile = (diags: Diag[]): Map<string, Diag[]> => {
  const m = new Map<string, Diag[]>();
  for (const d of diags) {
    if (!LLM_TARGET_SEVERITIES.has(d.severity)) continue;
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
// An identical reply is a legit "nothing to fix" (the caller skips writing it).
// null / <90% length / unbalanced braces|parens fail.
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

// Run the LLM fixer over each file that still has an error/warning. Returns the
// files written plus their pre/post-fix content (so the caller can diff
// old→new without re-reading disk, which later unrelated edits would poison).
export const applyFixes = async (
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<{ file: string; before: string; after: string }[]> => {
  const targets = Array.from(groupTargetsByFile(diags).entries()).slice(
    0,
    MAX_FIX_FILES,
  );
  const patched: { file: string; before: string; after: string }[] = [];

  for (const [file, errs] of targets) {
    let original: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      original = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fixed = await runFixerLLM(file, original, errs, ctx, signal);
    // Single pass, no retry: a stronger prompt over the full file, not another
    // round. Unsafe/unchanged output is skipped so it stays reported.
    if (!isSafeFix(original, fixed) || fixed === original) continue;
    try {
      // No backup — user has git. isSafeFix above (length floor, brace
      // balance, identity check) catches obvious bad outputs.
      fs.writeFileSync(file, fixed, "utf8");
      // Capture the written bytes now: reading disk later would mislabel any
      // intervening unrelated edit as part of this auto-fix.
      patched.push({ file, before: original, after: fixed });
    } catch {
      /* ignore */
    }
  }
  return patched;
};
