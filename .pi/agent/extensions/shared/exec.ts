// Spawn a child process and collect stdout/stderr/exit code. Never rejects:
// spawn errors resolve as code -1 with the message on stderr.

import { spawn } from "node:child_process";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  cwd?: string,
  timeoutMs: number = 120_000,
): Promise<ExecResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
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
