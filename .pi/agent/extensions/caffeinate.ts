import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";

const ASSERTION_TTL_MS = 60_000;

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  let runStartedAt: number | null = null;
  let lastActivityAt = 0;
  let runningTools = 0;
  let prompting = false;
  let assertion: ChildProcess | null = null;
  let renewal: ReturnType<typeof setInterval> | null = null;

  const holdDeadline = (): number =>
    runStartedAt === null || prompting
      ? 0
      : Math.min(
          runStartedAt + 100 * 60_000,
          runningTools > 0 ? Infinity : lastActivityAt + 5 * 60_000,
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
    runningTools = 0;
    prompting = false;
    release();
  };

  pi.on("agent_start", () => {
    runStartedAt ??= Date.now();
    onActivity();
  });
  pi.on("turn_start", onActivity);
  pi.on("turn_end", onActivity);
  pi.on("message_start", onActivity);
  pi.on("message_update", onActivity);
  pi.on("message_end", onActivity);
  pi.on("tool_execution_update", onActivity);
  pi.on("tool_execution_start", () => {
    runningTools++;
    onActivity();
  });
  pi.on("tool_execution_end", () => {
    runningTools = Math.max(0, runningTools - 1);
    onActivity();
  });
  pi.on("ui_prompt_start", () => {
    prompting = true;
    release();
  });
  pi.on("ui_prompt_end", () => {
    prompting = false;
    onActivity();
  });
  pi.on("agent_settled", endRun);
  pi.on("session_start", endRun);
  pi.on("session_shutdown", endRun);
}
