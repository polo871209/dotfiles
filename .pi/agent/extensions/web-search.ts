// web-search — minimal web research: search the web and read a page's content.
//
// Replaces npm:pi-web-access (github.com/nicobailon/pi-web-access), which was
// too heavy for what's actually used here: 7-provider fallback chains (Brave,
// Tavily, Parallel, Perplexity, OpenAI, Gemini API/Web) when this machine has
// zero of those API keys configured, plus a browser curator UI, YouTube/video/
// PDF extraction, and a summary-review workflow. None of it was in use. This
// file keeps only the two tools that were: web_search and fetch_content.
//
// Design decisions, and where each was ported/simplified from in the old
// package (SHA-pinned so the links stay valid regardless of upstream changes:
// github.com/nicobailon/pi-web-access/blob/7bdc30a65cf77273eb9c0034647b373bda4060d7/<file>):
//
// - Search backend: Exa's public MCP endpoint (mcp.exa.ai), a JSON-RPC POST
//   over plain HTTP — no API key, no MCP client wiring needed. This was the
//   *only* zero-config path in the old package's provider fallback chain (see
//   exa.ts's searchWithExaMcp/callExaMcp/parseMcpResults). Every other
//   provider needs a paid key this machine doesn't have, so the whole
//   fallback chain was dropped rather than ported.
// - Content extraction: @mozilla/readability + linkedom (parse) + turndown
//   (HTML->markdown), same 3 libs and same pipeline as extract.ts's
//   extractContent, minus its RSC/PDF/video/GitHub-HTML branches.
// - SSRF guard (assertSafeUrl/fetchSafely): trimmed rewrite of
//   ssrf-protection.ts's validateRemoteUrl/fetchRemoteUrl — blocks
//   localhost/private-IP targets and re-validates each redirect hop. Dropped:
//   configurable CIDR allowlist (ssrf.allowRanges), custom DNS lookup seam.
// - GitHub clone-instead-of-scrape (parseGitHubUrl/cloneGitHubRepo/
//   describeGithubPath): simplified rewrite of github-extract.ts's
//   extractGitHub. Same core idea (shallow `git clone`, tree/README for repo
//   root, dir listing or file content for blob/tree paths, local path handed
//   back for read/bash). Deliberately dropped: `gh` CLI integration (plain
//   `git clone` over https covers public repos), GitHub API fallback for
//   oversized/private repos or 40-char-SHA refs (those just fall through to
//   the normal HTML fetch instead), and the ~/.pi/web-search.json config
//   knobs for clone path/timeout/size limit (hardcoded constants instead).
//
// Deliberately out of scope, don't re-add without a real need: multi-provider
// search, curator/summary-review UI, YouTube/video/PDF extraction, any config
// file. If a future provider is genuinely free/zero-config like Exa, add it
// as an alternative in exaSearch's caller, not a whole fallback chain.
//
// mapLimit() bounds concurrency for multi-query/multi-url calls (4 searches,
// 3 fetches in flight) instead of unbounded Promise.all — same reasoning as
// extract.ts's pLimit(3), reimplemented without the dependency. fetchReadable
// rejects binary content-types (image/audio/video/font, pdf/zip/octet-stream)
// up front instead of dumping raw bytes through res.text() into the model.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { lookup as dnsLookup } from "node:dns/promises";
import { exposeRegisteredToolsToEval } from "./shared/bridge-tools";
import net from "node:net";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import {
  join,
  dirname,
  extname,
  resolve as resolvePath,
  sep as pathSep,
} from "node:path";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CONTENT_CHARS = 15_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BINARY_CONTENT_TYPES = /^(image|audio|video|font)\//i;
const UNSUPPORTED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/zip",
  "application/pdf",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
]);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Per-process dir: a shared machine-global path would let this session's
// shutdown rmSync clones another concurrent pi session is still reading.
const GITHUB_CLONE_DIR = join(tmpdir(), `pi-github-repos-${process.pid}`);
const CLONE_TIMEOUT_MS = 30_000;
const MAX_TREE_ENTRIES = 200;
const MAX_FILE_CHARS = 30_000;
const NON_CODE_SEGMENTS = new Set([
  "issues",
  "pull",
  "pulls",
  "discussions",
  "releases",
  "wiki",
  "actions",
  "settings",
  "security",
  "projects",
  "compare",
  "commits",
  "tags",
  "branches",
  "network",
  "forks",
]);
const NOISE_DIRS = new Set([
  "node_modules",
  "vendor",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".git",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".svg",
  ".mp4",
  ".mp3",
  ".zip",
  ".gz",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Runs `fn` over `items` with at most `limit` in flight, preserving order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Blocks requests into the local machine / private network so a malicious
// page or search result can't trick the agent into hitting internal services.
function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const lower = addr.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:127.")
  );
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dnsLookup(hostname, { all: true })).map((a) => a.address);
  for (const addr of addresses) {
    if (isPrivateAddress(addr))
      throw new Error(`Blocked internal address: ${addr}`);
  }
  return url;
}

async function fetchSafely(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<Response> {
  let current = await assertSafeUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const res = await fetch(current, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: withTimeout(signal),
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (redirects === MAX_REDIRECTS)
      throw new Error(`Too many redirects fetching ${current.toString()}`);
    current = await assertSafeUrl(new URL(location, current).toString());
  }
  throw new Error("Too many redirects");
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

// Exa's public MCP endpoint (https://mcp.exa.ai/mcp) needs no API key or
// account — it's a JSON-RPC tool call over plain HTTP, no MCP client needed.
async function exaSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults,
          livecrawl: "fallback",
          type: "auto",
          contextMaxCharacters: 2000,
        },
      },
    }),
    signal: withTimeout(signal),
  });
  if (!res.ok)
    throw new Error(
      `Exa search error ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );

  const body = await res.text();
  let payload: {
    result?: {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    error?: { message?: string };
  } | null = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const candidate = JSON.parse(line.slice(5).trim());
      if (candidate?.result || candidate?.error) {
        payload = candidate;
        break;
      }
    } catch {}
  }
  if (!payload) {
    try {
      payload = JSON.parse(body);
    } catch {}
  }
  if (!payload) throw new Error("Exa search returned an empty response");
  if (payload.error)
    throw new Error(`Exa search error: ${payload.error.message ?? "unknown"}`);
  const text = payload.result?.content?.find(
    (c) => c.type === "text" && c.text,
  )?.text;
  if (!text) throw new Error("Exa search returned no content");

  const blocks = text.split(/(?=^Title: )/m).filter((b) => b.trim());
  const results = blocks
    .map((block): SearchResult => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
      const textStart = block.indexOf("\nText: ");
      let content = "";
      if (textStart >= 0) {
        content = block.slice(textStart + 7);
      } else {
        const hlMatch = block.match(/\nHighlights:\s*\n/);
        if (hlMatch?.index != null)
          content = block.slice(hlMatch.index + hlMatch[0].length);
      }
      content = content.replace(/\n---\s*$/, "").trim();
      return { title, url, content };
    })
    .filter((r) => r.url);
  if (results.length === 0)
    throw new Error("Exa search returned no parseable results");
  return results;
}

async function fetchReadable(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string }> {
  const res = await fetchSafely(url, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${Math.round(Number(contentLength) / 1024 / 1024)}MB)`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const baseType = contentType.split(";")[0].trim().toLowerCase();
  if (
    BINARY_CONTENT_TYPES.test(baseType) ||
    UNSUPPORTED_CONTENT_TYPES.has(baseType)
  ) {
    throw new Error(`Unsupported content type: ${baseType || "unknown"}`);
  }

  const text = await res.text();
  if (!contentType.includes("html")) {
    return { title: url, content: text.slice(0, MAX_CONTENT_CHARS) };
  }

  const { document } = parseHTML(text);
  const article = new Readability(document as unknown as Document).parse();
  if (!article) throw new Error("Could not extract readable content from page");

  const markdown = turndown.turndown(article.content ?? "");
  return {
    title: article.title || url,
    content: markdown.slice(0, MAX_CONTENT_CHARS),
  };
}

interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path?: string;
  type: "root" | "blob" | "tree";
}

function parseGitHubUrl(rawUrl: string): GitHubUrlInfo | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

  if (segments.length === 2)
    return { owner, repo, refIsFullSha: false, type: "root" };

  const action = segments[2];
  if ((action !== "blob" && action !== "tree") || segments.length < 4)
    return null;
  const ref = segments[3];
  return {
    owner,
    repo,
    ref,
    refIsFullSha: /^[0-9a-f]{40}$/.test(ref),
    path: segments.slice(4).join("/"),
    type: action,
  };
}

// Dedupes concurrent/repeat clones of the same repo+ref within this process.
const cloneCache = new Map<string, Promise<string>>();

function execGitClone(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { timeout: CLONE_TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    );
    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

// Clones shallowly instead of scraping the rendered GitHub HTML page, so the
// agent gets real files it can `read`/`bash` into rather than markup soup.
async function cloneGitHubRepo(
  owner: string,
  repo: string,
  ref: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const key = ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
  const cached = cloneCache.get(key);
  if (cached) return cached;

  const localPath = join(
    GITHUB_CLONE_DIR,
    owner,
    ref ? `${repo}@${ref}` : repo,
  );
  const promise = (async () => {
    rmSync(localPath, { recursive: true, force: true });
    mkdirSync(dirname(localPath), { recursive: true });
    const args = ["clone", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    args.push(`https://github.com/${owner}/${repo}.git`, localPath);
    try {
      await execGitClone(args, signal);
    } catch (err) {
      rmSync(localPath, { recursive: true, force: true });
      cloneCache.delete(key);
      throw new Error(`git clone failed: ${errMsg(err)}`);
    }
    return localPath;
  })();
  cloneCache.set(key, promise);
  return promise;
}

function resolveWithinRepo(root: string, rel: string): string | null {
  const normalizedRoot = resolvePath(root);
  const candidate = resolvePath(normalizedRoot, rel);
  const prefix = normalizedRoot.endsWith(pathSep)
    ? normalizedRoot
    : normalizedRoot + pathSep;
  if (candidate !== normalizedRoot && !candidate.startsWith(prefix))
    return null;
  return candidate;
}

function isBinaryFile(path: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch {
    return false;
  }
  return false;
}

function buildRepoTree(root: string): string {
  const entries: string[] = [];
  function walk(dir: string, rel: string): void {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const relPath = rel ? `${rel}/${item}` : item;
      const full = join(dir, item);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${relPath}/ [skipped]`);
          continue;
        }
        entries.push(`${relPath}/`);
        walk(full, relPath);
      } else {
        entries.push(relPath);
      }
    }
  }
  walk(root, "");
  if (entries.length >= MAX_TREE_ENTRIES)
    entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  return entries.join("\n");
}

function readRepoReadme(root: string): string | null {
  for (const name of ["README.md", "readme.md", "README", "README.txt"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      return content.length > 8000
        ? content.slice(0, 8000) + "\n\n[README truncated]"
        : content;
    }
  }
  return null;
}

function describeGithubPath(root: string, info: GitHubUrlInfo): string {
  const lines: string[] = [`Cloned to: ${root}`, ""];

  if (info.type === "root") {
    lines.push("## Structure", buildRepoTree(root), "");
    const readme = readRepoReadme(root);
    if (readme) lines.push("## README.md", readme, "");
    lines.push(`Explore further with read/bash at ${root}`);
    return lines.join("\n");
  }

  const path = info.path ?? "";
  const target = resolveWithinRepo(root, path);
  if (!target || !existsSync(target)) {
    lines.push(
      `Path \`${path}\` not found in clone. Showing repo root instead.`,
      "",
      "## Structure",
      buildRepoTree(root),
      "",
      `Explore further with read/bash at ${root}`,
    );
    return lines.join("\n");
  }

  const stat = statSync(target);
  if (stat.isDirectory()) {
    const items = readdirSync(target)
      .sort()
      .filter((i) => i !== ".git");
    lines.push(`## ${path || "/"}`);
    lines.push(
      items
        .map((i) => {
          const s = statSync(join(target, i));
          return s.isDirectory() ? `  ${i}/` : `  ${i} (${s.size}B)`;
        })
        .join("\n") || "(empty)",
    );
    lines.push("", `Explore further with read/bash at ${target}`);
    return lines.join("\n");
  }

  if (isBinaryFile(target)) {
    lines.push(
      `## ${path}`,
      `Binary file (${stat.size}B). Use read/bash at ${target} to inspect.`,
    );
    return lines.join("\n");
  }

  const content = readFileSync(target, "utf-8");
  lines.push(`## ${path}`);
  lines.push(
    content.length > MAX_FILE_CHARS
      ? content.slice(0, MAX_FILE_CHARS) +
          `\n\n[truncated at ${MAX_FILE_CHARS} chars — full file at ${target}]`
      : content,
  );
  return lines.join("\n");
}

// GitHub URLs get cloned locally instead of scraped; everything else goes
// through fetchReadable. Clone failures (private repo, no git, offline) fall
// back to the normal HTML fetch so the tool still returns something.
async function fetchOne(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string }> {
  const gh = parseGitHubUrl(url);
  if (gh && !gh.refIsFullSha) {
    try {
      const root = await cloneGitHubRepo(gh.owner, gh.repo, gh.ref, signal);
      return {
        title: gh.path
          ? `${gh.owner}/${gh.repo} - ${gh.path}`
          : `${gh.owner}/${gh.repo}`,
        content: describeGithubPath(root, gh),
      };
    } catch {
      // fall through to HTML fetch below
    }
  }
  return fetchReadable(url, signal);
}

export default function (pi: ExtensionAPI) {
  exposeRegisteredToolsToEval(pi);
  pi.on("session_shutdown", () => {
    for (const promise of cloneCache.values()) {
      promise
        .then((dir) => rmSync(dir, { recursive: true, force: true }))
        .catch(() => {});
    }
    cloneCache.clear();
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web, no API key required. Returns title, URL, and a content snippet per result.",
    promptSnippet:
      "Search the web for research questions. Prefer multiple varied `queries` over one.",
    renderResult(result, _options, theme: Theme) {
      const d = result.details as
        { queries?: string[]; totalResults?: number } | undefined;
      return new Text(
        theme.fg(
          "dim",
          `  web_search "${d?.queries?.join(", ") ?? ""}" — ${d?.totalResults ?? 0} results`,
        ),
        0,
        0,
      );
    },
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Searched in sequence; vary phrasing for broader coverage.",
        }),
      ),
      numResults: Type.Optional(
        Type.Number({ description: "Results per query (default 5, max 10)." }),
      ),
    }),
    async execute(_callId, params, signal) {
      const queryList = (
        Array.isArray(params.queries)
          ? params.queries
          : params.query
            ? [params.query]
            : []
      ).filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0,
      );
      if (queryList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: no query provided. Use 'query' or 'queries'.",
            },
          ],
          details: {},
        };
      }
      const numResults = Math.min(
        Math.max(Math.floor(params.numResults ?? 5), 1),
        10,
      );

      const queryResults = await mapLimit(queryList, 4, async (query) => {
        try {
          return {
            query,
            results: await exaSearch(query, numResults, signal),
            error: null as string | null,
          };
        } catch (err) {
          return { query, results: [] as SearchResult[], error: errMsg(err) };
        }
      });

      let output = "";
      let totalResults = 0;
      for (const { query, results, error } of queryResults) {
        if (queryList.length > 1) output += `## Query: "${query}"\n\n`;
        if (error) {
          output += `Error: ${error}\n\n`;
          continue;
        }
        totalResults += results.length;
        output +=
          results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 400).replace(/\s+/g, " ")}`,
            )
            .join("\n\n") + "\n\n";
      }

      return {
        content: [{ type: "text", text: output.trim() }],
        details: { queries: queryList, totalResults },
      };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch a URL and extract its readable content as markdown (e.g. to read a web_search result in full). GitHub repo/file/dir URLs are cloned locally instead of scraped — the result includes a local path to explore further with read/bash.",
    promptSnippet:
      "Read the full content of a URL, such as a web_search result or a GitHub repo/file link.",
    renderResult(result, _options, theme: Theme) {
      const d = result.details as { urls?: string[]; ok?: number } | undefined;
      return new Text(
        theme.fg(
          "dim",
          `  fetch_content — ${d?.ok ?? 0}/${d?.urls?.length ?? 0} ok`,
        ),
        0,
        0,
      );
    },
    parameters: Type.Object({
      url: Type.Optional(Type.String()),
      urls: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_callId, params, signal) {
      const urlList = (
        Array.isArray(params.urls)
          ? params.urls
          : params.url
            ? [params.url]
            : []
      ).filter(
        (u): u is string => typeof u === "string" && u.trim().length > 0,
      );
      if (urlList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: no url provided. Use 'url' or 'urls'.",
            },
          ],
          details: {},
        };
      }

      const results = await mapLimit(urlList, 3, async (url) => {
        try {
          const { title, content } = await fetchOne(url, signal);
          return { url, title, content, error: null as string | null };
        } catch (err) {
          return { url, title: "", content: "", error: errMsg(err) };
        }
      });

      const output = results
        .map((r) =>
          r.error
            ? `## ${r.url}\nError: ${r.error}`
            : `## ${r.title}\n${r.url}\n\n${r.content}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: output }],
        details: { urls: urlList, ok: results.filter((r) => !r.error).length },
      };
    },
  });
}
