// The post-edit fix pipeline — one staged pass over the touched files:
//
//   (1) format        conform.nvim formatters
//   (2) diagnose      LSP + linters
//   (3) LSP code-fix  safe single-file code-actions (fixAll, organizeImports)
//   (4) re-diagnose
//   (5) LLM fix       LAST RESORT, only if an error/warning survived (3)
//   (6) re-diagnose   the files the LLM rewrote
//
// Stages 1–4 are deterministic and run together inside the nvim driver
// (runDriver → PiFeedback.run in feedback.lua). Stage 5 (llm-fix.ts) is the
// only non-deterministic step and is gated on a real error/warning remaining.
// fix=false stops after stage 4 (diagnose-only; used when /lsp-fix is off).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_FILES, runDriver } from "./driver";
import { applyFixes, LLM_TARGET_SEVERITIES } from "./llm-fix";
import type { DriverResult } from "./types";

export interface FixPipelineResult {
  final: DriverResult;
  fixedFiles: string[];
  fixResults: { file: string; before: string }[];
  hadFixable: boolean;
}

export const runFixPipeline = async (
  files: string[],
  cwd: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  fix: boolean,
): Promise<FixPipelineResult | null> => {
  // Stages 1–4: format + diagnose + deterministic LSP code-fix + re-diagnose.
  const first = await runDriver(files.slice(0, MAX_FILES), cwd, signal);
  if (!first) return null;

  // Gate stage 5 on a real error/warning surviving the deterministic pass.
  const hadFixable = first.diagnostics.some((d) =>
    LLM_TARGET_SEVERITIES.has(d.severity),
  );
  let final: DriverResult = first;
  let fixResults: { file: string; before: string }[] = [];
  let fixedFiles: string[] = [];

  if (fix && hadFixable) {
    // Stage 5: LLM last resort on what code-actions couldn't clear.
    fixResults = await applyFixes(first.diagnostics, ctx, signal);
    fixedFiles = fixResults.map((f) => f.file);
    if (fixedFiles.length > 0) {
      // Stage 6: re-diagnose only the rewritten files, merge over originals.
      const second = await runDriver(fixedFiles, cwd, signal);
      if (second) {
        const patchedSet = new Set(fixedFiles);
        final = {
          formatted: Array.from(
            new Set([...first.formatted, ...second.formatted]),
          ),
          diagnostics: [
            ...first.diagnostics.filter((d) => !patchedSet.has(d.file)),
            ...second.diagnostics,
          ],
        };
      }
    }
  }

  return { final, fixedFiles, fixResults, hadFixable };
};
