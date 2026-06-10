// Unified-diff helpers shared by the inline format hook and the batched fixer.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// Cap the diff we inline into an edit result / inject after a fix. Past this a
// formatter reflow is no cheaper than a re-read, so we tell the agent to re-read
// instead of dumping a huge diff into context.
export const MAX_DIFF_BYTES = 6 * 1024;

// Unified diff via the system `diff` (POSIX -u). Header lines carry temp paths,
// so strip them; the caller supplies the real path in prose. null = no diff /
// diff unavailable.
export const unifiedDiff = (before: string, after: string): string | null => {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lspfb-"));
    const a = path.join(dir, "before");
    const b = path.join(dir, "after");
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);
    const r = spawnSync("diff", ["-u", a, b], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status !== 1 || !r.stdout) return null; // 0 = identical, >1 = error
    return r.stdout
      .split("\n")
      .filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "))
      .join("\n")
      .trim();
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
};

// Message body telling the agent the file's on-disk bytes changed under it,
// so its edit result stays the source of truth and no re-read is needed.
export const changeNote = (
  before: string,
  after: string,
  rel: string,
  kind: "auto-formatted" | "auto-fixed",
): string => {
  const diff = unifiedDiff(before, after);
  if (diff && diff.length <= MAX_DIFF_BYTES) {
    return `[lsp-feedback] ${kind} \`${rel}\` on save. The on-disk file now differs from what you last saw only by the change below — treat this as the current file state, no re-read needed:\n\n\`\`\`diff\n${diff}\n\`\`\``;
  }
  return `[lsp-feedback] ${kind} \`${rel}\` on save (change too large for a compact diff). Re-read this file before your next edit to it.`;
};
