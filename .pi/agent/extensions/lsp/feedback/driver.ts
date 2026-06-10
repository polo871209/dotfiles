// Interface to the feedback Lua driver (_G.PiFeedback) inside the shared nvim:
// a fast format-only pass for the inline hook, and the full format + diagnostics
// + code-action pass for the batched turn-end run.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callLua, isRunning, loadLua } from "../nvim";
import type { DriverResult } from "./types";

const FEEDBACK_LUA = path.join(import.meta.dirname, "..", "feedback.lua");
const LOG_FILE = path.join(os.tmpdir(), "pi-lsp-feedback.log");

const logDriver = (msg: string) => {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8",
    );
  } catch {
    /* best effort */
  }
};

// Load _G.PiFeedback into the shared nvim once per session. Re-check
// isRunning() so /lsp-restart forces a reload of _G.PiFeedback into the fresh
// nvim.
let feedbackLoaded = false;
export const ensureFeedbackLoaded = async (cwd: string): Promise<void> => {
  if (feedbackLoaded && isRunning()) return;
  const src = fs.readFileSync(FEEDBACK_LUA, "utf8");
  await loadLua(cwd, src);
  feedbackLoaded = true;
};

// Lua side enforces PER_FILE_BUDGET_MS = 4500 + ~1s settle. Match here
// with headroom so the hard cap fires only on a wedged nvim.
const PER_FILE_BUDGET_MS = 5_500;
const BASE_TIMEOUT_MS = 3_000;
const nvimCallTimeoutMs = (fileCount: number): number =>
  BASE_TIMEOUT_MS + Math.max(1, fileCount) * PER_FILE_BUDGET_MS;
export const MAX_FILES = 25;
export const MAX_FILE_BYTES = 64 * 1024;

// Full pass: format + safe code-actions + diagnostics. Used at turn end.
export const runDriver = async (
  files: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DriverResult | null> => {
  try {
    await ensureFeedbackLoaded(cwd);
    // Hard cap via AbortSignal in case nvim wedges.
    const timeoutSignal = AbortSignal.timeout(nvimCallTimeoutMs(files.length));
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    return await callLua<DriverResult>(
      cwd,
      "return PiFeedback.run(...)",
      [files],
      combined,
    );
  } catch (e) {
    logDriver(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// Inline format-only pass: format this one file in the warm nvim and report
// whether it changed. Fast path (no diagnostics) so it can run synchronously
// inside the edit's tool_result hook.
export const formatFile = async (
  file: string,
  cwd: string,
): Promise<boolean> => {
  try {
    await ensureFeedbackLoaded(cwd);
    const res = await callLua<{ formatted: string[] }>(
      cwd,
      "return PiFeedback.format(...)",
      [[file]],
      AbortSignal.timeout(BASE_TIMEOUT_MS + PER_FILE_BUDGET_MS),
    );
    return !!res && res.formatted.length > 0;
  } catch (e) {
    logDriver(`format failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
};
