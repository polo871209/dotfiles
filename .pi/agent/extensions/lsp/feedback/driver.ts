import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callLua, type Lane, loadLuaOnce } from "../nvim";
import type { DriverResult } from "./types";

const FEEDBACK_LUA = path.join(import.meta.dirname, "..", "feedback.lua");

const logDriver = (msg: string) => {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), "pi-lsp-feedback.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8",
    );
  } catch {}
};

let feedbackSrc: { mtimeMs: number; src: string } | null = null;
export const ensureFeedbackLoaded = async (
  cwd: string,
  lane: Lane = "main",
): Promise<void> => {
  const mtimeMs = fs.statSync(FEEDBACK_LUA).mtimeMs;
  if (feedbackSrc?.mtimeMs !== mtimeMs)
    feedbackSrc = { mtimeMs, src: fs.readFileSync(FEEDBACK_LUA, "utf8") };
  await loadLuaOnce(cwd, "feedback", feedbackSrc.src, lane);
};
const nvimCallTimeoutMs = (fileCount: number): number =>
  Math.min(3_000 + Math.max(1, fileCount) * 5_500, 30_000);
export const MAX_FILE_BYTES = 64 * 1024;

export const runDriver = async (
  files: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DriverResult | null> => {
  try {
    await ensureFeedbackLoaded(cwd);
    const timeoutSignal = AbortSignal.timeout(nvimCallTimeoutMs(files.length));
    return await callLua<DriverResult>(
      cwd,
      "return PiFeedback.run(...)",
      [files],
      signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      undefined,
      "main",
    );
  } catch (e) {
    logDriver(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const INLINE_TIMEOUT_MS = 1_500;
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
    const remaining = INLINE_TIMEOUT_MS - (Date.now() - start);
    if (remaining <= INLINE_MARGIN_MS) return false;
    const res = await callLua<{ formatted: string[] }>(
      cwd,
      "return PiFeedback.format(...)",
      [[file], Math.min(1_200, remaining - INLINE_MARGIN_MS)],
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
