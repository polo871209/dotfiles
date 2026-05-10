// Replaces built-in /copy: opens picker when assistant response has fenced
// code blocks. Monkey-patches InteractiveMode.prototype.handleCopyCommand so
// no source patching of pi-coding-agent is needed.
import {
  InteractiveMode,
  copyToClipboard,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Block = { lang?: string; code: string };

const sanitizeLang = (lang: string): string | undefined => {
  const clean = lang.replace(/[^a-zA-Z0-9_+.-]/g, "").trim();
  return clean.length > 0 ? clean : undefined;
};

const extractCodeBlocks = (text: string): Block[] => {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(`{3,})(.*)$/);
    if (!open) continue;
    const fence = open[1];
    const lang = sanitizeLang(open[2].trim().split(/\s+/)[0] ?? "");
    const codeLines: string[] = [];
    let closed = false;
    for (i = i + 1; i < lines.length; i++) {
      if (lines[i].startsWith(fence)) {
        closed = true;
        break;
      }
      codeLines.push(lines[i]);
    }
    if (closed) blocks.push({ lang, code: codeLines.join("\n") });
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

const proto = InteractiveMode.prototype as unknown as {
  __copyPickerPatched?: boolean;
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

if (!proto.__copyPickerPatched) {
  proto.__copyPickerPatched = true;
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
    const idx = blockLabels.indexOf(selected);
    if (idx < 0) {
      this.showError("Copy target not found.");
      return;
    }
    await copy(blocks[idx].code, `code block ${idx + 1}`);
  };
}

export default function (_pi: ExtensionAPI) {}
