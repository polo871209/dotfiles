import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./shared/error";
import { preview } from "./shared/format";
import { icon } from "./shared/icons";
import { LINK_OPEN, LINK_READY } from "./shared/link";

type Fence = {
  indent: string;
  marker: string;
  lang?: string;
  code: string;
  start: number;
  end: number;
  closed: boolean;
};

type TextMessage = { role: "user" | "assistant"; text: string };

const COPY_LINK = /^pi-copy:(\w+)$/;

const parseFences = (lines: string[]): Fence[] => {
  const fences: Fence[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = lines[i].match(/^( *)(`{3,}|~{3,})(.*)$/);

    if (!open) {
      i++;
      continue;
    }

    const [, indent, marker, info] = open;
    const close = new RegExp(`^ *${marker[0]}{${marker.length},}\\s*$`);
    const codeLines: string[] = [];
    let j = i + 1;

    while (j < lines.length && !close.test(lines[j])) {
      const line = lines[j];
      codeLines.push(line.slice(Math.min(indent.length, line.length - line.trimStart().length)));
      j++;
    }

    const lang = info
      .trim()
      .split(/\s+/)[0]
      .replace(/[^\w+.-]/g, "");

    fences.push({
      indent,
      marker,
      lang: lang || undefined,
      code: codeLines.join("\n"),
      start: i,
      end: Math.min(j, lines.length - 1),
      closed: j < lines.length,
    });
    i = j + 1;
  }

  return fences;
};

const hashKey = (code: string): string =>
  createHash("sha1").update(code).digest("hex").slice(0, 10);

const textMessages = (ctx: ExtensionContext): TextMessage[] =>
  ctx.sessionManager.getBranch().flatMap((entry): TextMessage[] => {
    if (entry.type !== "message") return [];
    const { role } = entry.message;

    if (role !== "user" && role !== "assistant") return [];
    const text = contentText(entry.message.content).trim();

    return text ? [{ role, text }] : [];
  });

const copyWithNotify = async (
  ctx: ExtensionContext,
  value: string,
  label: string,
): Promise<void> => {
  try {
    await copyToClipboard(value);
    ctx.ui.notify(`Copied ${label} to clipboard`);
  } catch (e) {
    ctx.ui.notify(errorMessage(e), "error");
  }
};

const copyBlocks = async (ctx: ExtensionContext): Promise<void> => {
  const text = textMessages(ctx)
    .filter((m) => m.role === "assistant")
    .at(-1)?.text;

  if (!text) {
    ctx.ui.notify("No assistant messages yet", "warning");

    return;
  }

  const blocks = parseFences(text.split("\n"));

  if (blocks.length === 0) return copyWithNotify(ctx, text, "response");

  if (blocks.length === 1) return copyWithNotify(ctx, blocks[0].code, "code block");

  const labels = blocks.map(
    (b, i) =>
      `Block ${i + 1} [${b.lang ?? "txt"}] — ${b.code.split("\n").length}L — ${preview(b.code)}`,
  );

  const selected = await ctx.ui.select("Select a code block to copy", labels);

  if (selected === undefined) return;
  const index = labels.indexOf(selected);
  await copyWithNotify(ctx, blocks[index].code, `code block ${index + 1}`);
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-blocks", {
    description: "Pick a code block from the last response and copy it",
    handler: async (_args, ctx) => copyBlocks(ctx),
  });
  pi.registerShortcut("ctrl+alt+c", {
    description: "Pick a code block from the last response and copy it",
    handler: copyBlocks,
  });

  pi.registerCommand("copy-all", {
    description: "Copy entire session history (user + assistant) as markdown",
    handler: async (_args, ctx) => {
      const messages = textMessages(ctx);

      if (messages.length === 0) {
        ctx.ui.notify("Session is empty", "warning");

        return;
      }

      const name = ctx.sessionManager.getSessionName();

      const text = [
        ...(name ? [`# ${name}`, ""] : []),
        ...messages.flatMap((m) => [`## ${m.role}`, "", m.text, ""]),
      ]
        .join("\n")
        .trimEnd();

      await copyWithNotify(ctx, `${text}\n`, `session (${messages.length} messages)`);
    },
  });

  const blocks = new Map<string, string>();
  let currentCtx: ExtensionContext | undefined;
  let linksReady = false;
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
  });
  pi.events.on(LINK_READY, () => {
    linksReady = true;
  });
  pi.events.on(LINK_OPEN, (url) => {
    const key = typeof url === "string" && COPY_LINK.exec(url)?.[1];

    if (!key || !currentCtx) return;
    const code = blocks.get(key);

    if (code === undefined)
      currentCtx.ui.notify("That code block is no longer on screen", "warning");
    else void copyWithNotify(currentCtx, code, "code block");
  });

  pi.registerMarkdownTransformer(
    (markdown, context) => {
      if (!linksReady || context.isStreaming) return markdown;
      const lines = markdown.split("\n");

      const fences = parseFences(lines).filter(
        (f) => f.closed && f.lang?.toLowerCase() !== "mermaid",
      );

      if (fences.length === 0) return markdown;
      const out: string[] = [];
      let cursor = 0;

      for (const fence of fences) {
        const key = hashKey(fence.code);
        blocks.set(key, fence.code);
        out.push(
          ...lines.slice(cursor, fence.end + 1),
          `${fence.indent}[${icon.contentCopy} copy](pi-copy:${key})`,
        );
        cursor = fence.end + 1;

        if (lines[cursor]?.trim()) out.push("");
      }

      out.push(...lines.slice(cursor));

      return out.join("\n");
    },
    { messageTypes: ["assistant"] },
  );
}
