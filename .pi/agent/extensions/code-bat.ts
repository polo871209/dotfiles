// code-bat — replace pi's code-block syntax highlighter with `bat`.
//
// Pi renders fenced code blocks via `pi-tui`'s `Markdown` component, which
// calls `theme.highlightCode(text, lang)` on each render to colorize lines.
// The default implementation uses `cli-highlight` (highlight.js for CLI),
// which often produces drab/incorrect output (e.g. no coloring on JSON).
//
// This extension monkey-patches `Markdown.prototype` with a property
// descriptor for `theme` that wraps any incoming theme object in a Proxy.
// The Proxy intercepts `theme.highlightCode` and returns a function that
// shells out to `bat --color=always --style=plain --paging=never`.
//
// `bat` is slow per-invocation (~50ms), so results are memoized by
// (lang, content) forever. After first render of a given block, it's free.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";

type HighlightFn = (code: string, lang?: string) => string[];

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

  const mapped = LANG_MAP[langKey];
  // No-language and shell fences: let theme use mdCodeBlock color.
  if (!mapped || mapped === "sh") {
    const fallback = code.split("\n");
    if (cache.size < MAX_CACHE) cache.set(cacheKey, fallback);
    return fallback;
  }

  const args = [
    "--color=always",
    "--style=plain",
    "--paging=never",
    "--decorations=never",
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

  if (cache.size >= MAX_CACHE) {
    // simple FIFO eviction
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey, result);
  return result;
};

let installed = false;
const installPatch = () => {
  if (installed) return;
  installed = true;
  const proto = Markdown.prototype as unknown as Record<string, unknown>;
  const slot = Symbol("themeSlot");
  Object.defineProperty(proto, "theme", {
    configurable: true,
    enumerable: true,
    get(this: { [k: symbol]: unknown }) {
      return this[slot];
    },
    set(this: { [k: symbol]: unknown }, t: object | undefined) {
      if (!t || typeof t !== "object") {
        this[slot] = t;
        return;
      }
      this[slot] = new Proxy(t, {
        get(target, prop, receiver) {
          if (prop === "highlightCode") return batHighlight;
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  });
};

export default function (_pi: ExtensionAPI) {
  // Patch on module load — Markdown instances created from now on get the
  // bat-backed highlighter. Existing already-rendered components keep their
  // current theme (no-op in practice; messages are re-created on session
  // start anyway).
  installPatch();
}
