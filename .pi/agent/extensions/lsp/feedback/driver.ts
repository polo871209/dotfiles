// Interface to the feedback Lua driver (_G.PiFeedback), loaded into each nvim
// lane: a fast format-only pass for the inline hook (inline lane), and the
// full format + diagnostics + code-action pass for the batched turn-end run
// (main lane).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callLua, isRunning, type Lane, loadLua } from "../nvim";
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

// Load _G.PiFeedback into a lane's nvim once per session. Re-check
// isRunning() so /lsp-restart forces a reload of _G.PiFeedback into the fresh
// nvim.
const feedbackLoaded: Record<Lane, boolean> = { main: false, inline: false };
export const ensureFeedbackLoaded = async (
  cwd: string,
  lane: Lane = "main",
): Promise<void> => {
  if (feedbackLoaded[lane] && isRunning(lane)) return;
  const src = fs.readFileSync(FEEDBACK_LUA, "utf8");
  await loadLua(cwd, src, lane);
  feedbackLoaded[lane] = true;
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

// Inline format-only pass: format this one file and report whether it changed.
// Runs on the dedicated "inline" nvim lane so it never queues behind the heavy
// turn-end diagnostics pass (main lane). Short budget: it blocks the edit's
// tool_result hook, so give up fast rather than stall the agent. The deadline
// covers ensureFeedbackLoaded too — spawn/load take no signal, and a wedged
// startup (e.g. a config error breaking the RPC channel) must not hang edits.
// The lua-side format budget must stay below the JS deadline: conform writes
// the buffer on success, and a write landing after we stopped awaiting would
// silently desync the agent's view of the file.
const INLINE_TIMEOUT_MS = 1_500;
const INLINE_LUA_FORMAT_MS = 1_200;
// Headroom between the lua budget and the JS deadline so a format finishing
// right at the wire still gets awaited instead of writing after we gave up.
const INLINE_MARGIN_MS = 100;
export const formatFile = async (
  file: string,
  cwd: string,
): Promise<boolean> => {
  try {
    const start = Date.now();
    const deadline = AbortSignal.timeout(INLINE_TIMEOUT_MS);
    await Promise.race([
      ensureFeedbackLoaded(cwd, "inline"),
      new Promise<never>((_, reject) =>
        deadline.addEventListener(
          "abort",
          () => reject(new Error("inline nvim not ready in time")),
          { once: true },
        ),
      ),
    ]);
    // ensureFeedbackLoaded ate into the shared deadline: give lua only what's
    // left, and skip entirely when a write couldn't land before we stop waiting.
    const remaining = INLINE_TIMEOUT_MS - (Date.now() - start);
    if (remaining <= INLINE_MARGIN_MS) return false;
    const res = await callLua<{ formatted: string[] }>(
      cwd,
      "return PiFeedback.format(...)",
      [[file], Math.min(INLINE_LUA_FORMAT_MS, remaining - INLINE_MARGIN_MS)],
      deadline,
      undefined,
      "inline",
    );
    return !!res && res.formatted.length > 0;
  } catch (e) {
    logDriver(`format failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
};
