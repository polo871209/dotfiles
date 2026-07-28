// Spawn a child process and collect stdout/stderr/exit code. Never rejects:
// spawn errors resolve as code -1 with the message on stderr.

import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Always bounded: without a default cap, a hung child (e.g. `gh` waiting on
// auth) hangs the awaiting tool call forever when the caller passes no signal.
const DEFAULT_TIMEOUT_MS = 120_000;

export function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, signal: combined });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on("error", (err) =>
      resolve({ stdout: "", stderr: err.message, code: -1 }),
    );
  });
}
