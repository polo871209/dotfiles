#!/usr/bin/env node
// Renders a Mermaid source with the same engine and width rule as the pi TUI, so a diagram
// that overflows is caught here instead of degrading into raw source in the transcript.
// Usage: node mermaid-fit.mjs diagram.mmd [--width N]   |   cat diagram.mmd | node mermaid-fit.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function piPackageDir() {
  try {
    const shim = realpathSync(
      execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(),
    );
    const target = readFileSync(shim, "utf8").match(/target=(\S+)/)?.[1];
    return target ? join(dirname(shim), target, "..") : dirname(shim);
  } catch {
    return undefined;
  }
}

function resolveRenderer() {
  const roots = [process.cwd(), piPackageDir()].filter(Boolean);
  for (const root of roots) {
    try {
      return require.resolve("grok-mermaid", { paths: [root] });
    } catch {}
  }
  for (const root of roots) {
    const hits = globSync("**/grok-mermaid/dist/index.js", {
      cwd: join(root, "..", ".."),
    });
    if (hits.length > 0) return join(root, "..", "..", hits.sort().at(-1));
  }
  return undefined;
}

// The TUI compares the art against the message content width, which is the pane minus its
// padding. The exact padding depends on settings, so hold back a few columns.
const MARGIN = 4;

function limitWidth() {
  const flag = process.argv.indexOf("--width");
  if (flag !== -1 && process.argv[flag + 1])
    return Number(process.argv[flag + 1]);
  for (const command of [
    "tmux display-message -p '#{pane_width}'",
    "tput cols </dev/tty",
  ]) {
    try {
      const value = Number(
        execFileSync("sh", ["-c", command], { encoding: "utf8" }).trim(),
      );
      if (Number.isFinite(value) && value > 20) return value - MARGIN;
    } catch {}
  }
  return (process.stdout.columns ?? 80) - MARGIN;
}

const file = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--") && !/^\d+$/.test(argument));
const source = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const rendererPath = resolveRenderer();
if (!rendererPath) {
  console.error(
    "grok-mermaid not found. Set the path with PI_GROK_MERMAID or run inside the pi install.",
  );
  process.exit(2);
}

const { render, diagramKind } = await import(
  process.env.PI_GROK_MERMAID ?? rendererPath
);
const art = render(source);
const limit = limitWidth();
if (!art) {
  const kind = diagramKind(source);
  const cause =
    kind === null
      ? "unsupported diagram type"
      : `syntax error in the ${kind} diagram`;
  console.log(
    `FAIL ${cause}, the TUI prints the source instead. limit=${limit}`,
  );
  process.exit(1);
}
console.log(art.plain.join("\n"));
for (const warning of art.warnings) console.log(`WARN ${warning}`);
const verdict = art.width <= limit ? "OK" : "TOO WIDE";
console.log(`${verdict} width=${art.width} limit=${limit}`);
process.exit(art.width <= limit && art.warnings.length === 0 ? 0 : 1);
