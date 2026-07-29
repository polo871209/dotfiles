// Deterministic post-edit feedback pass. Neovim opens every touched file,
// allows configured diagnostics producers to run, applies only conservative
// single-file LSP fixAll/organizeImports actions, then settles and reads the
// aggregate vim.diagnostic state across the original file set.
import { runDriver } from "./driver";
import type { DriverResult } from "./types";

export interface FixPipelineResult {
  final: DriverResult;
}

export const runFixPipeline = async (
  files: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  stale: () => boolean = () => false,
): Promise<FixPipelineResult | null> => {
  if (stale()) return null;
  const final = await runDriver(files, cwd, signal, () => !stale());
  return final ? { final } : null;
};
