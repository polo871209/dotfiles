import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

export const changeNote = (
  before: string,
  after: string,
  rel: string,
): string => {
  const diff = generateUnifiedPatch(rel, before, after)
    .split("\n")
    .slice(2)
    .join("\n")
    .trim();
  if (diff.length <= 6 * 1024) {
    return `[lsp-feedback] auto-formatted \`${rel}\` on save. The on-disk file now differs from what you last saw only by the change below — treat this as the current file state, no re-read needed:\n\n\`\`\`diff\n${diff}\n\`\`\``;
  }
  return `[lsp-feedback] auto-formatted \`${rel}\` on save (change too large for a compact diff). Re-read this file before your next edit to it.`;
};
