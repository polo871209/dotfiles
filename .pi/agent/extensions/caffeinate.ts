import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";

const MAX_HOLD_MS = 100 * 60_000;
const QUIET_LIMIT_MS = 5 * 60_000;
const ASSERTION_TTL_MS = 60_000;

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  let runStartedAt: number | null = null;
  let lastActivityAt = 0;
  let prompting = false;
  let assertion: ChildProcess | null = null;
  let renewal: ReturnType<typeof setInterval> | null = null;

  const holdDeadline = (): number =>
    runStartedAt === null || prompting
      ? 0
      : Math.min(
          runStartedAt + MAX_HOLD_MS,
          lastActivityAt + QUIET_LIMIT_MS,
          Date.now() + ASSERTION_TTL_MS,
        );

  const release = (): void => {
    if (renewal) clearInterval(renewal);
    renewal = null;
    assertion?.kill("SIGKILL");
    assertion = null;
  };

  // powerd enforces -t even while caffeinate is stopped, which Ctrl+Z does to
  // pi's whole process group. So every hold expires unless a live pi renews it.
  const renew = (): void => {
    const seconds = Math.floor((holdDeadline() - Date.now()) / 1000);
    if (seconds < 1) {
      release();
      return;
    }
    const previous = assertion;
    const child = spawn(
      "caffeinate",
      ["-i", "-t", String(seconds), "-w", String(process.pid)],
      { stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
    assertion = child;
    previous?.kill("SIGKILL");
    if (!renewal) {
      renewal = setInterval(renew, ASSERTION_TTL_MS / 3);
      renewal.unref();
    }
  };

  const onActivity = (): void => {
    lastActivityAt = Date.now();
    if (!assertion) renew();
  };

  const endRun = (): void => {
    runStartedAt = null;
    prompting = false;
    release();
  };

  pi.on("agent_start", async () => {
    runStartedAt ??= Date.now();
    onActivity();
  });
  pi.on("turn_start", async () => onActivity());
  pi.on("turn_end", async () => onActivity());
  pi.on("message_start", async () => onActivity());
  pi.on("message_update", async () => onActivity());
  pi.on("message_end", async () => onActivity());
  pi.on("tool_execution_start", async () => onActivity());
  pi.on("tool_execution_update", async () => onActivity());
  pi.on("tool_execution_end", async () => onActivity());
  pi.on("ui_prompt_start", async () => {
    prompting = true;
    release();
  });
  pi.on("ui_prompt_end", async () => {
    prompting = false;
    onActivity();
  });
  pi.on("agent_settled", async () => endRun());
  pi.on("session_start", async () => endRun());
  pi.on("session_shutdown", async () => endRun());
}
