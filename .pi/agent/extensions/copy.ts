// /copy-blocks — picker over fenced code blocks in the last assistant
// response. /copy-all — copy entire session history (user + assistant)
// as markdown. Built-in /copy (last assistant verbatim) is left alone.
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { extractText } from "./shared/message";

type Block = { lang?: string; code: string };

const sanitizeLang = (lang: string): string | undefined => {
  const clean = lang.replace(/[^a-zA-Z0-9_+.-]/g, "").trim();
  return clean.length > 0 ? clean : undefined;
};

const extractCodeBlocks = (text: string): Block[] => {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^(`{3,})(.*)$/);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1];
    const lang = sanitizeLang(open[2].trim().split(/\s+/)[0] ?? "");
    const codeLines: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (lines[j].startsWith(fence)) {
        closed = true;
        break;
      }
      codeLines.push(lines[j]);
      j++;
    }
    if (closed) blocks.push({ lang, code: codeLines.join("\n") });
    i = j + 1;
  }
  return blocks;
};

const truncate = (text: string, limit = 60): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
};

const previewText = (text: string): string => {
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return truncate(first ?? "(empty)");
};

const lineCount = (text: string): number =>
  text.length === 0 ? 1 : text.split("\n").length;

const lastAssistantText = (
  ctx: ExtensionCommandContext,
): string | undefined => {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const m = entry.message as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    const text = extractText(m.content).trim();
    if (text) return text;
  }
};

const formatSession = (ctx: ExtensionCommandContext): string => {
  const lines: string[] = [];
  const name = ctx.sessionManager.getSessionName?.();
  if (name) lines.push(`# ${name}`, "");
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const m = entry.message as { role?: string; content?: unknown };
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = extractText(m.content).trim();
    if (!text) continue;
    lines.push(`## ${m.role}`, "", text, "");
  }
  return lines.join("\n").trimEnd() + "\n";
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-blocks", {
    description:
      "Pick a fenced code block from last assistant response and copy",
    handler: async (_args, ctx) => {
      const text = lastAssistantText(ctx);
      if (!text) {
        ctx.ui.notify("No assistant messages yet", "warning");
        return;
      }
      const blocks = extractCodeBlocks(text);

      const copy = async (value: string, label: string) => {
        try {
          await copyToClipboard(value);
          ctx.ui.notify(`Copied ${label} to clipboard`, "info");
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
      };

      if (blocks.length === 0) {
        await copy(text, "response");
        return;
      }
      if (blocks.length === 1) {
        await copy(blocks[0].code, "code block");
        return;
      }

      const fullLabel = `Full response — ${lineCount(text)} lines`;
      const blockLabels = blocks.map(
        (b, i) =>
          `Block ${i + 1} [${b.lang ?? "txt"}] — ${lineCount(b.code)}L — ${previewText(b.code)}`,
      );
      const options = [fullLabel, ...blockLabels];

      const selected = await ctx.ui.select("Select content to copy", options);
      if (!selected) {
        ctx.ui.notify("Copy cancelled", "info");
        return;
      }
      if (selected === fullLabel) {
        await copy(text, "response");
        return;
      }
      const idx = blockLabels.indexOf(selected);
      if (idx < 0) {
        ctx.ui.notify("Copy target not found", "error");
        return;
      }
      await copy(blocks[idx].code, `code block ${idx + 1}`);
    },
  });

  pi.registerCommand("copy-all", {
    description: "Copy entire session history (user + assistant) as markdown",
    handler: async (_args, ctx) => {
      const text = formatSession(ctx);
      if (!text.trim()) {
        ctx.ui.notify("Session is empty", "warning");
        return;
      }
      try {
        await copyToClipboard(text);
        const turns = (text.match(/^## /gm) ?? []).length;
        ctx.ui.notify(
          `Copied session (${turns} turns, ${text.length} chars)`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(
          `copy-all failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });
}
