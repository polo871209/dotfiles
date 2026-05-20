// Replaces built-in /copy: opens picker when assistant response has fenced
// code blocks. Monkey-patches InteractiveMode.prototype.handleCopyCommand so
// no source patching of pi-coding-agent is needed.
import {
  InteractiveMode,
  copyToClipboard,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

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

type Proto = {
  handleCopyCommand: () => Promise<void>;
  session: { getLastAssistantText(): string | undefined };
  showError(msg: string): void;
  showStatus(msg: string): void;
  showExtensionSelector(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined>;
};

const installPatch = () => {
  const proto = InteractiveMode.prototype as unknown as Proto;
  // Guard against pi upgrades that rename/remove this method.
  if (typeof proto.handleCopyCommand !== "function") {
    console.warn(
      "[copy] InteractiveMode.handleCopyCommand missing — pi version may have changed; skipping patch",
    );
    return;
  }
  // Re-assign on every load so /reload picks up new code. We fully replace
  // (no chaining), so reassignment is idempotent.
  proto.handleCopyCommand = async function () {
    const text = this.session.getLastAssistantText();
    if (!text) {
      this.showError("No agent messages to copy yet.");
      return;
    }
    const blocks = extractCodeBlocks(text);

    const copy = async (value: string, label: string) => {
      try {
        await copyToClipboard(value);
        this.showStatus(`Copied ${label} to clipboard`);
      } catch (error) {
        this.showError(error instanceof Error ? error.message : String(error));
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

    const selected = await this.showExtensionSelector(
      "Select content to copy",
      options,
    );
    if (!selected) {
      this.showStatus("Copy cancelled");
      return;
    }
    if (selected === fullLabel) {
      await copy(text, "response");
      return;
    }
    const blockIdx = blockLabels.indexOf(selected);
    if (blockIdx < 0) {
      this.showError("Copy target not found.");
      return;
    }
    await copy(blocks[blockIdx].code, `code block ${blockIdx + 1}`);
  };
};

installPatch();

const extractText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text",
    )
    .map((c) => c.text)
    .join("\n");
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
