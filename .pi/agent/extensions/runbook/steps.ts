import { createHash } from "node:crypto";

export type Step = {
  key: string;
  title?: string;
  code: string;
  lang?: string;
  shell: boolean;
};

export type Fence = {
  indent: string;
  marker: string;
  lang?: string;
  code: string;
  start: number;
  end: number;
  closed: boolean;
};

const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "fish"]);

const sanitizeLang = (lang: string): string | undefined => {
  const clean = lang.replace(/[^a-zA-Z0-9_+.-]/g, "").trim();
  return clean.length > 0 ? clean : undefined;
};

export const parseFences = (lines: string[]): Fence[] => {
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
      codeLines.push(
        line.slice(
          Math.min(indent.length, line.length - line.trimStart().length),
        ),
      );
      j++;
    }
    fences.push({
      indent,
      marker,
      lang: sanitizeLang(info.trim().split(/\s+/)[0] ?? ""),
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

const hasOddQuotes = (text: string): boolean =>
  (text.match(/'/g)?.length ?? 0) % 2 === 1 ||
  (text.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;

const shellStep = (lang: string, chunk: string): Step => {
  const lines = chunk.split("\n");
  const title: string[] = [];
  while (lines.length > 1 && /^\s*#(?!!)/.test(lines[0]))
    title.push((lines.shift() as string).replace(/^\s*#+\s*/, ""));
  const code = lines.join("\n");
  return {
    key: hashKey(code),
    title: title.join(" ") || undefined,
    code,
    lang,
    shell: true,
  };
};

export const fenceSteps = (fence: Fence): Step[] => {
  if (!fence.lang || !SHELL_LANGS.has(fence.lang.toLowerCase()))
    return [
      {
        key: hashKey(fence.code),
        code: fence.code,
        lang: fence.lang,
        shell: false,
      },
    ];
  const lang = fence.lang;
  const chunks = fence.code.split(/\n[ \t]*\n/).filter((c) => c.trim());
  const splittable =
    chunks.length > 1 &&
    !fence.code.includes("<<") &&
    !chunks.some(hasOddQuotes);
  return (splittable ? chunks : [fence.code]).map((c) => shellStep(lang, c));
};

export const textSteps = (text: string): Step[] =>
  parseFences(text.split("\n"))
    .filter((f) => f.closed)
    .flatMap(fenceSteps);

export type RunbookStep = { title: string; command: string };

export const runbookSteps = (
  toolCallId: string,
  steps: readonly Partial<RunbookStep>[],
): Step[] =>
  steps.map((s, i) => ({
    key: `${toolCallId}:${i}`,
    title: s.title,
    code: s.command ?? "",
    lang: "sh",
    shell: true,
  }));
