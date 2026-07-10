// code-blocks — replace pi's code-block syntax highlighter with `bat`, and
// frame each block as a panel (header with language, left gutter).
//
// Pi renders fenced code blocks via `pi-tui`'s `Markdown` component, which
// calls `theme.highlightCode(text, lang)` on each render to colorize lines.
// The default implementation uses `cli-highlight` (highlight.js for CLI),
// which often produces drab/incorrect output (e.g. no coloring on JSON).
//
// This extension monkey-patches `Markdown.prototype.render` and swaps
// `this.theme.highlightCode` to a function that shells out to `bat
// --color=always --style=plain --paging=never`. We can't patch the `theme`
// property via Object.defineProperty on the prototype because Markdown
// declares `theme;` as an ES2022 class field — the constructor's
// `this.theme = theme` uses [[DefineOwnProperty]] which bypasses prototype
// setters.
//
// `bat` is slow per-invocation (~50ms), so results are memoized by
// (lang, content) forever. After first render of a given block, it's free.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";

type HighlightFn = (code: string, lang?: string) => string[];

const GUTTER_FG = "\x1b[38;5;245m";
const RESET_SGR = "\x1b[0m";

const cache = new Map<string, string[]>();
const MAX_CACHE = 500;
// Languages bat recognizes well; everything else falls through unhighlighted.
// Map common pi/highlight.js language tags to bat's preferred names.
const LANG_MAP: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  py: "py",
  python: "py",
  rs: "rs",
  rust: "rs",
  go: "go",
  rb: "rb",
  ruby: "rb",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  lua: "lua",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "md",
  markdown: "md",
  html: "html",
  css: "css",
  scss: "scss",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  swift: "swift",
  php: "php",
  sql: "sql",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  nix: "nix",
  zig: "zig",
};

const batHighlight: HighlightFn = (code: string, lang?: string) => {
  const langKey = (lang ?? "").toLowerCase().trim();
  const cacheKey = `${langKey}\0${code}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const decorate = (lines: string[]): string[] =>
    lines.map((l) => `${GUTTER_FG}│${RESET_SGR} ${l}`);

  const mapped = LANG_MAP[langKey];
  // No-language and shell fences: let theme use mdCodeBlock color.
  if (!mapped || mapped === "sh") {
    const fallback = decorate(code.split("\n"));
    if (cache.size < MAX_CACHE) cache.set(cacheKey, fallback);
    return fallback;
  }

  const args = [
    "--color=always",
    "--style=plain",
    "--paging=never",
    "--decorations=never",
    "--theme=Catppuccin Mocha",
    "-l",
    mapped,
  ];

  let result: string[];
  try {
    const r = spawnSync("bat", args, {
      input: code,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0 && r.stdout) {
      // bat appends a trailing newline; strip before splitting.
      const out = r.stdout.replace(/\n$/, "");
      result = out.split("\n");
    } else {
      result = code.split("\n");
    }
  } catch {
    result = code.split("\n");
  }

  result = decorate(result);
  if (cache.size >= MAX_CACHE) {
    // simple FIFO eviction
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey, result);
  return result;
};

type BorderFn = (text: string) => string;

// Replace the ``` fence lines with panel borders. Open/close both arrive as
// codeBlockBorder("```..."), distinguished by a toggle: markdown emits them
// strictly paired within one synchronous render. Re-assigned on every render
// (like highlightCode) so /reload picks up changes, and the toggle resets
// per render so it can never stay desynced.
const BORDER_TAG = "__cbBorderOrig";
const patchBorder = (t: {
  codeBlockBorder?: BorderFn;
  [BORDER_TAG]?: BorderFn;
}) => {
  const orig = (t[BORDER_TAG] ??= t.codeBlockBorder);
  if (!orig) return;
  let open = false;
  // Markdown indents code lines by 2 but not fence lines — prepend the same
  // indent so ╭/╰ line up with the │ gutter, and use the gutter's color
  // instead of the theme's dim fence color so the frame reads as one shape.
  t.codeBlockBorder = (text: string) => {
    if (!text.startsWith("```")) return orig(text);
    open = !open;
    if (open) {
      const lang = text.slice(3).trim();
      return `  ${GUTTER_FG}╭─ ${lang || "code"}${RESET_SGR}`;
    }
    return `  ${GUTTER_FG}╰──${RESET_SGR}`;
  };
};

const PATCH_TAG = "__codeBlocksPatched";
const installPatch = () => {
  const proto = Markdown.prototype as unknown as {
    render(width: number): string[];
    theme?: { highlightCode?: HighlightFn };
  };
  // Find the original render: walk past any prior code-blocks wrappers from
  // previous /reload runs so we don't stack wrappers (which causes earlier
  // wrappers to clobber our highlightCode assignment).
  let origRender = proto.render as unknown as {
    (width: number): string[];
    [PATCH_TAG]?: { orig: typeof origRender };
  };
  while (origRender[PATCH_TAG]) {
    origRender = origRender[PATCH_TAG]!.orig;
  }
  const wrapper = function (this: { theme?: object }, width: number) {
    const t = this.theme as
      { highlightCode?: HighlightFn; codeBlockBorder?: BorderFn } | undefined;
    if (t && typeof t === "object") {
      // Always (re)assign, so reload picks up new batHighlight closure.
      t.highlightCode = batHighlight;
      patchBorder(t);
    }
    return origRender.call(this, width);
  } as unknown as typeof origRender;
  wrapper[PATCH_TAG] = { orig: origRender };
  proto.render = wrapper as unknown as typeof proto.render;
};

export default function (_pi: ExtensionAPI) {
  // Patch on module load — Markdown instances created from now on get the
  // bat-backed highlighter. Existing already-rendered components keep their
  // current theme (no-op in practice; messages are re-created on session
  // start anyway).
  installPatch();
}
