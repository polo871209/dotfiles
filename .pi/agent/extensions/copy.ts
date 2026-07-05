// /copy-blocks — picker over fenced code blocks in the last assistant
// response. /copy-all — copy entire session history (user + assistant)
// as markdown. Built-in /copy (last assistant verbatim) is left alone.
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { collectTextMessages, extractText } from "./shared/message";

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
    while (j < lines.length && !lines[j].startsWith(fence)) {
      codeLines.push(lines[j]);
      j++;
    }
    // Unclosed fence (response truncated mid-block) is still treated as a
    // block closed at EOF, matching how Markdown itself handles it.
    blocks.push({ lang, code: codeLines.join("\n") });
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
  const { messages } = collectTextMessages(ctx.sessionManager.getBranch());
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const text = extractText(messages[i].content).trim();
    if (text) return text;
  }
};

const formatSession = (ctx: ExtensionCommandContext): string => {
  const lines: string[] = [];
  const name = ctx.sessionManager.getSessionName?.();
  if (name) lines.push(`# ${name}`, "");
  const { messages } = collectTextMessages(ctx.sessionManager.getBranch());
  for (const m of messages) {
    const text = extractText(m.content).trim();
    if (!text) continue;
    lines.push(`## ${m.role}`, "", text, "");
  }
  return lines.join("\n").trimEnd() + "\n";
};

const copyWithNotify = async (
  ctx: ExtensionCommandContext,
  value: string,
  label: string,
): Promise<void> => {
  try {
    await copyToClipboard(value);
    ctx.ui.notify(`Copied ${label} to clipboard`, "info");
  } catch (e) {
    ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
  }
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

      if (blocks.length === 0) {
        await copyWithNotify(ctx, text, "response");
        return;
      }
      if (blocks.length === 1) {
        await copyWithNotify(ctx, blocks[0].code, "code block");
        return;
      }

      const blockLabels = blocks.map(
        (b, i) =>
          `Block ${i + 1} [${b.lang ?? "txt"}] — ${lineCount(b.code)}L — ${previewText(b.code)}`,
      );

      const selected = await ctx.ui.select(
        "Select content to copy",
        blockLabels,
      );
      if (!selected) {
        ctx.ui.notify("Copy cancelled", "info");
        return;
      }
      const idx = blockLabels.indexOf(selected);
      if (idx < 0) {
        ctx.ui.notify("Copy target not found", "error");
        return;
      }
      await copyWithNotify(ctx, blocks[idx].code, `code block ${idx + 1}`);
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
      const turns = (text.match(/^## /gm) ?? []).length;
      await copyWithNotify(
        ctx,
        text,
        `session (${turns} turns, ${text.length} chars)`,
      );
    },
  });
}
