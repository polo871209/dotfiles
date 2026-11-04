export const rexDoArgs = (
  script: string,
  args: unknown,
  options: { session?: string; json?: boolean } = {},
): string[] => [
  "do",
  ...(options.session ? ["-s", options.session] : []),
  script,
  ...(options.json ? ["--json"] : []),
  "--args",
  JSON.stringify(args),
];
