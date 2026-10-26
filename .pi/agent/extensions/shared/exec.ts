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
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on("error", (err) =>
      resolve({
        stdout,
        stderr: [err.message, stderr].filter(Boolean).join("\n"),
        code: -1,
      }),
    );
  });
}
