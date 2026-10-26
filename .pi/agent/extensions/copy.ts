import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lastAssistantText, textMessages } from "./shared/message";

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
    const open = lines[i].match(/^( *)(`{3,}|~{3,})(.*)$/);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[2];
    const codeLines: string[] = [];
    let j = i + 1;
    while (
      j < lines.length &&
      !new RegExp(`^ *${fence[0]}{${fence.length},}\\s*$`).test(lines[j])
    ) {
      const line = lines[j];
      codeLines.push(
        line.slice(
          Math.min(open[1].length, line.length - line.trimStart().length),
        ),
      );
      j++;
    }
    blocks.push({
      lang: sanitizeLang(open[3].trim().split(/\s+/)[0] ?? ""),
      code: codeLines.join("\n"),
    });
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
  return truncate(
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "(empty)",
  );
};

const lineCount = (text: string): number =>
  text.length === 0 ? 1 : text.split("\n").length;

const formatSession = (
  ctx: ExtensionContext,
): { text: string; turns: number } => {
  const lines: string[] = [];
  const name = ctx.sessionManager.getSessionName();
  if (name) lines.push(`# ${name}`, "");
  const messages = textMessages(ctx.sessionManager.getBranch());
  for (const m of messages) lines.push(`## ${m.role}`, "", m.text, "");
  return { text: lines.join("\n").trimEnd() + "\n", turns: messages.length };
};

const copyWithNotify = async (
  ctx: ExtensionContext,
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

const copyBlocks = async (ctx: ExtensionContext): Promise<void> => {
  const text = lastAssistantText(ctx.sessionManager.getBranch());
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

  const selected = await ctx.ui.select("Select content to copy", blockLabels);
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
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-blocks", {
    description:
      "Pick a fenced code block from last assistant response and copy",
    handler: async (_args, ctx) => copyBlocks(ctx),
  });

  pi.registerShortcut("ctrl+alt+c", {
    description: "Pick a code block from the last response and copy it",
    handler: copyBlocks,
  });

  pi.registerCommand("copy-all", {
    description: "Copy entire session history (user + assistant) as markdown",
    handler: async (_args, ctx) => {
      const { text, turns } = formatSession(ctx);
      if (turns === 0) {
        ctx.ui.notify("Session is empty", "warning");
        return;
      }
      await copyWithNotify(
        ctx,
        text,
        `session (${turns} turns, ${text.length} chars)`,
      );
    },
  });
}
