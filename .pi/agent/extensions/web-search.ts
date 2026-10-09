import type { ClassifierBoolQuestion } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { boolProbabilities, findJev, type JevModel } from "./shared/jev";
import { lookup as dnsLookup } from "node:dns/promises";
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
  mkdtempSync,
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
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const EXA_TEXT_CHARS = 1_500;
const RERANK_SNIPPET_CHARS = 600;
const RERANK_MAX_CANDIDATES = 10;
// Measured 2026-01 over 4 queries: pages that answered scored 0.54-0.98 and
// the rest 0.12-0.33. Before moving the floor, log scoreCandidates scores for
// real queries.
const RERANK_FLOOR = 0.35;
const RERANK_MIN_KEEP = 3;
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
// Per-mode, because one hardcoded text/html value made mode:"raw" against
// api.github.com fail with HTTP 415. Both keep a */* tail so a server that
// negotiates strictly still answers.
const ACCEPT_HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const ACCEPT_RAW = "application/json,text/plain;q=0.9,*/*;q=0.8";

const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const SEARCH_RETRY_DELAY_MS = 500;

const EXTRACT_CACHE_TTL_MS = 5 * 60_000;
const EXTRACT_CACHE_MAX_ENTRIES = 16;
const EXTRACT_CACHE_MAX_CHARS = 2_000_000;

const GH_TIMEOUT_MS = 20_000;
const MAX_ISSUE_COMMENTS = 30;
const MAX_ISSUE_COMMENT_CHARS = 4_000;

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

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);
const YOUTUBE_PATH_PREFIXES = ["shorts", "embed", "live", "v"];
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_DLP_TIMEOUT_MS = 90_000;
const YT_PREFERRED_SUB_LANGS = "en-orig,en,en-US,en-GB";

function disableMarkdownEscaping(service: TurndownService): void {
  service.escape = (text: string) => text;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
disableMarkdownEscaping(turndown);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

// Expands an IPv6 literal into its 8 groups, including the "::" run and a
// trailing dotted-quad. Needed because a textual prefix test cannot see
// through normalization: Node rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1.
function parseIPv6Groups(addr: string): number[] | null {
  const bare = addr.split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (net.isIPv4(piece)) {
        const [a, b, c, d] = piece.split(".").map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = parseHalf(halves[0]);
  const tail = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

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

  const groups = parseIPv6Groups(addr.toLowerCase());
  if (!groups) return false;
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [g6, g7] = groups.slice(6);
    return isPrivateAddress(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if (groups.every((g, i) => (i === 7 ? g <= 1 : g === 0))) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  return false;
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
  accept: string = ACCEPT_HTML,
): Promise<{ res: Response; finalUrl: string }> {
  let current = await assertSafeUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const res = await fetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      redirect: "manual",
      signal: withTimeout(signal),
    });
    if (!REDIRECT_STATUSES.has(res.status))
      return { res, finalUrl: current.toString() };
    const location = res.headers.get("location");
    if (!location) return { res, finalUrl: current.toString() };
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

class RetryableSearchError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callMcpTool(
  endpoint: string,
  label: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: withTimeout(signal),
  });
  if (!res.ok) {
    const detail = `${label} search error ${res.status}: ${(await res.text()).slice(0, 300)}`;
    throw res.status === 429 || res.status >= 500
      ? new RetryableSearchError(detail)
      : new Error(detail);
  }

  const body = await res.text();
  let payload: {
    result?: {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    error?: { message?: string };
  } | null = null;
  // One endpoint answers as plain JSON or as SSE, so try event lines first.
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
  if (!payload) throw new Error(`${label} search returned an empty response`);
  if (payload.error)
    throw new Error(
      `${label} search error: ${payload.error.message ?? "unknown"}`,
    );
  const text = payload.result?.content?.find(
    (c) => c.type === "text" && c.text,
  )?.text;
  if (!text) throw new Error(`${label} search returned no content`);
  return text;
}

// Exa's public MCP endpoint exposes the advanced tool only when the query
// string asks for it (verified live via tools/list). It returns structured
// JSON, not a `Title:`/`URL:` text blob, and takes textMaxCharacters plus
// highlights, so results carry the matched passages, not the page head.
async function exaAdvancedSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const text = await callMcpTool(
    `${EXA_MCP_URL}?tools=web_search_advanced_exa`,
    "Exa",
    "web_search_advanced_exa",
    {
      query,
      numResults,
      type: "auto",
      textMaxCharacters: EXA_TEXT_CHARS,
      enableHighlights: true,
      highlightsNumSentences: 2,
    },
    signal,
  );
  const payload = JSON.parse(text) as {
    results?: Array<{
      url?: string;
      title?: string;
      text?: string;
      highlights?: string[];
    }>;
  };
  const results = (payload.results ?? [])
    .map((r): SearchResult => {
      const highlights = Array.isArray(r.highlights)
        ? r.highlights.join(" … ")
        : "";
      return {
        title: r.title?.trim() ?? "",
        url: r.url?.trim() ?? "",
        content: [highlights, r.text?.trim()]
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(0, EXA_TEXT_CHARS),
      };
    })
    .filter((r) => r.url);
  if (results.length === 0)
    throw new Error("Exa search returned no parseable results");
  return results;
}

async function exaBasicSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const text = await callMcpTool(
    EXA_MCP_URL,
    "Exa",
    "web_search_exa",
    { query, numResults },
    signal,
  );

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
      content = content
        .replace(/\n---\s*$/, "")
        .trim()
        .slice(0, EXA_TEXT_CHARS);
      return { title, url, content };
    })
    .filter((r) => r.url);
  if (results.length === 0)
    throw new Error("Exa search returned no parseable results");
  return results;
}

async function parallelSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const text = await callMcpTool(
    PARALLEL_MCP_URL,
    "Parallel",
    "web_search",
    { objective: query, search_queries: [query] },
    signal,
  );
  const payload = JSON.parse(text) as {
    results?: Array<{ url?: string; title?: string; excerpts?: string[] }>;
  };
  const results = (payload.results ?? [])
    .map((r): SearchResult => {
      const excerpts = Array.isArray(r.excerpts) ? r.excerpts : [];
      return {
        title: r.title?.trim() ?? "",
        url: r.url?.trim() ?? "",
        content: excerpts.join("\n").trim().slice(0, EXA_TEXT_CHARS),
      };
    })
    .filter((r) => r.url)
    .slice(0, numResults);
  if (results.length === 0)
    throw new Error("Parallel search returned no parseable results");
  return results;
}

async function duckDuckGoSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(DUCKDUCKGO_URL);
  url.searchParams.set("q", query);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: withTimeout(signal),
  });
  if (!res.ok)
    throw new Error(
      `DuckDuckGo search error ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );

  const { document } = parseHTML(
    await readBoundedText(res, MAX_RESPONSE_BYTES),
  );
  const results: SearchResult[] = [];
  for (const container of document.querySelectorAll(".result")) {
    if (container.classList.contains("result--ad")) continue;
    const anchor = container.querySelector(".result__a");
    const title = anchor?.textContent?.trim() ?? "";
    const href = anchor?.getAttribute("href")?.trim();
    if (!title || !href) continue;
    let target: string;
    try {
      const link = new URL(href, DUCKDUCKGO_URL);
      const destination = new URL(link.searchParams.get("uddg") ?? link.href);
      if (destination.protocol !== "http:" && destination.protocol !== "https:")
        continue;
      target = destination.href;
    } catch {
      continue;
    }
    results.push({
      title,
      url: target,
      content:
        container.querySelector(".result__snippet")?.textContent?.trim() ?? "",
    });
    if (results.length >= numResults) break;
  }
  if (results.length === 0)
    throw new Error("DuckDuckGo returned no parseable results");
  return results;
}

function dedupKey(raw: string): { page: string; query: string } {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_|ref$|source$)/i.test(key))
        url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/+$/, "");
    return {
      page: `${url.hostname.replace(/^www\./i, "").toLowerCase()}${path}`,
      query: url.search,
    };
  } catch {
    return { page: raw, query: "" };
  }
}

function dedupResults(
  results: SearchResult[],
  seen = new Map<string, Set<string>>(),
): SearchResult[] {
  return results.filter((r) => {
    const { page, query } = dedupKey(r.url);
    const queries = seen.get(page);
    if (!queries) {
      seen.set(page, new Set([query]));
      return true;
    }
    if (queries.has(query)) return false;
    if (query === "" || queries.has("")) return false;
    queries.add(query);
    return true;
  });
}

function isTransient(err: unknown): boolean {
  if (err instanceof RetryableSearchError) return true;
  const message = errMsg(err).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("terminated") ||
    message.includes("timeouterror") ||
    message.includes("socket")
  );
}

// Order measured 2026-01 over 3 queries, median snippet per result: Exa ~4000
// chars, Parallel 1500, DuckDuckGo 150-300. Exa is also the least reliable (a
// 20s timeout on one query), hence the chain.
const SEARCH_PROVIDERS: Array<{
  name: string;
  run: (
    query: string,
    numResults: number,
    signal?: AbortSignal,
  ) => Promise<SearchResult[]>;
}> = [
  { name: "exa", run: exaAdvancedSearch },
  { name: "exa-basic", run: exaBasicSearch },
  { name: "parallel", run: parallelSearch },
  { name: "duckduckgo", run: duckDuckGoSearch },
];

async function runSearch(
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; provider: string }> {
  const failures: string[] = [];
  for (const [index, provider] of SEARCH_PROVIDERS.entries()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return {
          results: await provider.run(query, numResults, signal),
          provider: provider.name,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (index === 0 && attempt === 0 && isTransient(err)) {
          await sleep(SEARCH_RETRY_DELAY_MS + Math.floor(Math.random() * 250));
          continue;
        }
        failures.push(`${provider.name}: ${errMsg(err)}`);
        break;
      }
    }
  }
  throw new Error(failures.join("; "));
}

async function scoreCandidates(
  ctx: ExtensionContext,
  jev: JevModel,
  query: string,
  candidates: SearchResult[],
  signal?: AbortSignal,
): Promise<Array<number | null> | null> {
  const questions: Record<string, ClassifierBoolQuestion> = {};
  candidates.forEach((_, i) => {
    questions[`c${i}`] = {
      type: "bool",
      instructions: `Does the search result at \`candidates[${i}]\` answer \`query\`?`,
      criteria: {
        true: "The page is about the query's subject and its text carries the specific facts, documentation, or code the query asks for.",
        false:
          "The page only shares keywords with the query, covers a different subject or version, or is a listing, index, or advertisement with no substance on the query.",
      },
    };
  });

  const probabilities = await boolProbabilities(
    ctx,
    jev,
    {
      state: {
        query,
        candidates: candidates.map((r) => ({
          title: r.title,
          url: r.url,
          text: r.content.slice(0, RERANK_SNIPPET_CHARS),
        })),
      },
      questions,
    },
    8_000,
    signal,
  );
  if (!probabilities) return null;
  const scores = candidates.map((_, i) => probabilities[`c${i}`] ?? null);
  return scores.some((s) => s !== null) ? scores : null;
}

async function rerankResults(
  ctx: ExtensionContext,
  jev: JevModel | undefined,
  query: string,
  results: SearchResult[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!jev || results.length < 2) return results;
  const candidates = results.slice(0, RERANK_MAX_CANDIDATES);
  const scores = await scoreCandidates(ctx, jev, query, candidates, signal);
  if (!scores) return results;

  const scored = candidates
    .map((result, i) => ({ result, i, score: scores[i] }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.i - b.i);
  const kept = scored.filter(
    (s, rank) => rank < RERANK_MIN_KEEP || (s.score ?? 0) >= RERANK_FLOOR,
  );
  return kept.map((s) => s.result);
}

async function readBoundedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        throw new Error(
          `Response too large (>${Math.round(maxBytes / 1024 / 1024)}MB)`,
        );
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  out += decoder.decode();
  return out;
}

function sliceWithContinuation(
  content: string,
  offset: number,
): {
  text: string;
  truncated: boolean;
  nextOffset: number;
  totalChars: number;
} {
  const totalChars = content.length;
  const start = Math.min(Math.max(offset, 0), totalChars);
  let end = Math.min(start + MAX_CONTENT_CHARS, totalChars);
  if (end < totalChars) {
    const minBreak = start + Math.floor((end - start) * 0.9);
    const lastNewline = content.lastIndexOf("\n", end);
    const lastSpace = content.lastIndexOf(" ", end);
    if (lastNewline > minBreak) end = lastNewline;
    else if (lastSpace > minBreak) end = lastSpace;
  }
  return {
    text: content.slice(start, end),
    truncated: end < totalChars,
    nextOffset: end,
    totalChars,
  };
}

function withContinuationFooter(
  content: string,
  offset: number,
  url: string,
): string {
  const { text, truncated, nextOffset, totalChars } = sliceWithContinuation(
    content,
    offset,
  );
  if (!truncated) return text;
  return `${text}\n\n[chars ${offset}-${nextOffset} of ${totalChars}. To continue: fetch_content({ url: "${url}", offset: ${nextOffset} })]`;
}

function absolutizeUrls(document: Document, baseUrl: string): void {
  const rewrite = (selector: string, attribute: string) => {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (!value || /^(data|javascript|mailto|tel):/i.test(value)) continue;
      try {
        element.setAttribute(attribute, new URL(value, baseUrl).toString());
      } catch {}
    }
  };
  rewrite("a[href]", "href");
  rewrite("img[src]", "src");
}

function extractFallbackContent(document: Document): string {
  for (const element of document.querySelectorAll(
    "script, style, noscript, svg, iframe, form, nav, header, footer, aside",
  )) {
    element.remove();
  }
  const body = document.querySelector("main") ?? document.body;
  if (!body) return "";
  return turndown
    .turndown(body.innerHTML ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchReadable(
  url: string,
  signal?: AbortSignal,
  mode: "readable" | "raw" = "readable",
): Promise<{ title: string; content: string }> {
  const { res, finalUrl } = await fetchSafely(
    url,
    signal,
    mode === "raw" ? ACCEPT_RAW : ACCEPT_HTML,
  );
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

  const text = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (mode === "raw" || !contentType.includes("html")) {
    return { title: url, content: text };
  }

  const { document } = parseHTML(text);
  absolutizeUrls(document as unknown as Document, finalUrl);
  const documentTitle =
    document.querySelector("title")?.textContent?.trim() ?? "";
  // Readability mutates the document it parses, so the fallback works on a
  // second parse of the original HTML.
  const article = new Readability(document as unknown as Document).parse();
  const markdown = article ? turndown.turndown(article.content ?? "") : "";
  if (markdown.trim()) {
    return { title: article?.title || documentTitle || url, content: markdown };
  }

  const { document: raw } = parseHTML(text);
  absolutizeUrls(raw as unknown as Document, finalUrl);
  const fallback = extractFallbackContent(raw as unknown as Document);
  if (!fallback)
    throw new Error("Could not extract readable content from page");
  return { title: documentTitle || url, content: fallback };
}

function parseYouTubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const candidates: Array<string | undefined> = [
    url.searchParams.get("v") ?? undefined,
  ];
  if (url.hostname.toLowerCase().endsWith("youtu.be"))
    candidates.push(segments[0]);
  if (segments.length >= 2 && YOUTUBE_PATH_PREFIXES.includes(segments[0]))
    candidates.push(segments[1]);

  for (const candidate of candidates) {
    if (candidate && YOUTUBE_ID.test(candidate)) return candidate;
  }
  return null;
}

function execCapture(
  file: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr
            .split(/\r?\n/)
            .map((l) => l.replace(/^ERROR:\s*/, "").trim())
            .filter(Boolean)
            .pop();
          const failure = new Error(
            detail ? `${file}: ${detail}` : `${file} failed: ${err.message}`,
          ) as NodeJS.ErrnoException;
          failure.code = (err as NodeJS.ErrnoException).code;
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (signal) {
      const onAbort = () => child.kill();
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

function vttToText(raw: string): string {
  const out: string[] = [];
  let previous = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(rawLine)) continue;
    if (/^(Kind|Language):/.test(rawLine)) continue;
    if (rawLine.includes("-->")) continue;
    if (/^\d+$/.test(rawLine.trim())) continue;
    const line = decodeEntities(rawLine.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!line || line === previous) continue;
    out.push(line);
    previous = line;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");
}

async function downloadSubtitleFile(
  dir: string,
  videoId: string,
  langs: string,
  signal?: AbortSignal,
): Promise<string | null> {
  await execCapture(
    "yt-dlp",
    [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--write-info-json",
      "--sub-format",
      "vtt",
      "--sub-langs",
      langs,
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "-o",
      join(dir, "sub"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    YT_DLP_TIMEOUT_MS,
    signal,
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".vtt"))
    .sort();
  const best = files.sort((a, b) => a.length - b.length)[0];
  return best ? join(dir, best) : null;
}

async function fallbackSubLang(
  videoId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { stdout } = await execCapture(
    "yt-dlp",
    [
      "--list-subs",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    YT_DLP_TIMEOUT_MS,
    signal,
  );
  const manual: string[] = [];
  const automatic: string[] = [];
  let bucket: string[] | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^\[info\] Available automatic captions/.test(line)) {
      bucket = automatic;
      continue;
    }
    if (/^\[info\] Available subtitles/.test(line)) {
      bucket = manual;
      continue;
    }
    if (/^\[/.test(line)) {
      bucket = null;
      continue;
    }
    const code = line.match(/^([A-Za-z0-9_-]{2,})\s+\S/)?.[1];
    if (!bucket || !code || code === "Language" || code === "live_chat")
      continue;
    bucket.push(code);
  }
  return (
    manual.find((c) => c.endsWith("-orig")) ??
    automatic.find((c) => c.endsWith("-orig")) ??
    manual[0] ??
    automatic[0] ??
    null
  );
}

function readVideoMetadata(dir: string): Record<string, unknown> {
  const infoFile = readdirSync(dir).find((f) => f.endsWith(".info.json"));
  if (!infoFile) return {};
  try {
    return JSON.parse(readFileSync(join(dir, infoFile), "utf-8"));
  } catch {
    return {};
  }
}

async function fetchYouTubeTranscript(
  videoId: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-youtube-"));
  try {
    let subtitleFile = await downloadSubtitleFile(
      dir,
      videoId,
      YT_PREFERRED_SUB_LANGS,
      signal,
    );
    if (!subtitleFile) {
      const fallbackLang = await fallbackSubLang(videoId, signal);
      if (fallbackLang)
        subtitleFile = await downloadSubtitleFile(
          dir,
          videoId,
          fallbackLang,
          signal,
        );
    }
    if (!subtitleFile)
      throw new Error("no subtitles or auto-captions available for this video");

    const transcript = vttToText(readFileSync(subtitleFile, "utf-8"));
    if (!transcript) throw new Error("subtitle track was empty");

    const info = readVideoMetadata(dir);
    const title =
      typeof info.title === "string" ? info.title : `YouTube ${videoId}`;
    const header = [
      typeof info.channel === "string" ? `Channel: ${info.channel}` : null,
      typeof info.duration_string === "string"
        ? `Duration: ${info.duration_string}`
        : null,
      `Transcript language: ${subtitleFile.match(/\.([A-Za-z0-9_-]+)\.vtt$/)?.[1] ?? "unknown"}`,
      "Timestamps removed.",
    ]
      .filter(Boolean)
      .join("\n");

    return { title, content: `${header}\n\n${transcript}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function sweepDeadClones(): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^pi-github-repos-(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid || pidAlive(pid)) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const cloneCache = new Map<string, Promise<string>>();

function execGitClone(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        timeout: CLONE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      },
      (err) => (err ? reject(err) : resolve()),
    );
    if (signal) {
      const onAbort = () => child.kill();
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

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
    if (existsSync(join(localPath, ".git"))) return localPath;
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
    lines.push(`Explore further at local path: ${root}`);
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
      `Explore further at local path: ${root}`,
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
    lines.push("", `Explore further at local path: ${target}`);
    return lines.join("\n");
  }

  if (isBinaryFile(target)) {
    lines.push(
      `## ${path}`,
      `Binary file (${stat.size}B). Full local path: ${target}`,
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

interface GitHubIssueRef {
  owner: string;
  repo: string;
  number: string;
}

function parseGitHubIssueUrl(rawUrl: string): GitHubIssueRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4) return null;
  const [owner, repo, kind, number] = segments;
  if (kind !== "issues" && kind !== "pull") return null;
  if (!/^\d+$/.test(number)) return null;
  return { owner, repo: repo.replace(/\.git$/, ""), number };
}

async function fetchGitHubIssue(
  ref: GitHubIssueRef,
  signal?: AbortSignal,
): Promise<{ title: string; content: string }> {
  const base = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  const { stdout } = await execCapture(
    "gh",
    ["api", base],
    GH_TIMEOUT_MS,
    signal,
  );
  const issue = JSON.parse(stdout) as {
    number: number;
    title: string;
    state: string;
    state_reason?: string | null;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
    created_at?: string;
    comments?: number;
    body?: string | null;
    pull_request?: unknown;
  };

  const kind = issue.pull_request ? "Pull request" : "Issue";
  const labels = (issue.labels ?? [])
    .map((l) => l.name)
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${kind} ${ref.owner}/${ref.repo}#${issue.number}: ${issue.title}`,
    `State: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ""}`,
    `Author: ${issue.user?.login ?? "unknown"}`,
    labels ? `Labels: ${labels}` : null,
    issue.created_at ? `Opened: ${issue.created_at}` : null,
    "",
    issue.body?.trim() || "(no description)",
  ].filter((l) => l !== null);

  if ((issue.comments ?? 0) > 0) {
    const { stdout: commentsJson } = await execCapture(
      "gh",
      ["api", `${base}/comments?per_page=${MAX_ISSUE_COMMENTS}`],
      GH_TIMEOUT_MS,
      signal,
    );
    const comments = JSON.parse(commentsJson) as Array<{
      user?: { login?: string };
      created_at?: string;
      body?: string | null;
    }>;
    for (const comment of comments) {
      const body = (comment.body ?? "").trim();
      lines.push(
        "",
        `## Comment by ${comment.user?.login ?? "unknown"}${comment.created_at ? ` (${comment.created_at})` : ""}`,
        body.length > MAX_ISSUE_COMMENT_CHARS
          ? `${body.slice(0, MAX_ISSUE_COMMENT_CHARS)}\n[comment truncated]`
          : body || "(empty)",
      );
    }
    if ((issue.comments ?? 0) > comments.length) {
      lines.push(
        "",
        `[${issue.comments} comments total, showing first ${comments.length}]`,
      );
    }
  }

  if (issue.pull_request) {
    lines.push(
      "",
      `[Use github_pr for diffs, checks, and review threads: { pr: ${issue.number}, repo: "${ref.owner}/${ref.repo}" }]`,
    );
  }
  return {
    title: `${ref.owner}/${ref.repo}#${issue.number}: ${issue.title}`,
    content: lines.join("\n"),
  };
}

async function fetchOne(
  url: string,
  signal?: AbortSignal,
  mode: "readable" | "raw" = "readable",
): Promise<{ title: string; content: string }> {
  const videoId = parseYouTubeVideoId(url);
  if (videoId) {
    try {
      return await fetchYouTubeTranscript(videoId, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT")
        throw new Error(`YouTube transcript failed: ${errMsg(err)}`);
    }
  }

  const issueRef = mode === "raw" ? null : parseGitHubIssueUrl(url);
  if (issueRef) {
    try {
      return await fetchGitHubIssue(issueRef, signal);
    } catch {
      // gh missing, unauthenticated, or private repo: scrape the page instead.
    }
  }

  const gh = mode === "raw" ? null : parseGitHubUrl(url);
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
  return fetchReadable(url, signal, mode);
}

interface CachedExtraction {
  title: string;
  content: string;
  storedAt: number;
}

const extractCache = new Map<string, CachedExtraction>();

async function fetchOneCached(
  url: string,
  signal?: AbortSignal,
  mode: "readable" | "raw" = "readable",
): Promise<{ title: string; content: string }> {
  const key = `${mode}:${url}`;
  const hit = extractCache.get(key);
  if (hit && Date.now() - hit.storedAt < EXTRACT_CACHE_TTL_MS) {
    extractCache.delete(key);
    extractCache.set(key, hit);
    return { title: hit.title, content: hit.content };
  }
  extractCache.delete(key);

  const extracted = await fetchOne(url, signal, mode);
  if (extracted.content.length <= EXTRACT_CACHE_MAX_CHARS) {
    extractCache.set(key, { ...extracted, storedAt: Date.now() });
    while (extractCache.size > EXTRACT_CACHE_MAX_ENTRIES) {
      const oldest = extractCache.keys().next().value;
      if (oldest === undefined) break;
      extractCache.delete(oldest);
    }
  }
  return extracted;
}

const nonEmptyText = Type.String({ minLength: 1 });
const searchQueries = Type.Array(nonEmptyText, {
  minItems: 1,
  description: "Varied queries for broad research.",
});
// Root must be a plain Type.Object: pi-ai sends Anthropic only the root
// `properties`, so an Intersect or Union root reaches the model as `{}`.
const searchParameters = Type.Object({
  query: Type.Optional(nonEmptyText),
  queries: Type.Optional(searchQueries),
  numResults: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 10,
      default: 5,
      description: "Keep the default of 5 unless the task needs breadth.",
    }),
  ),
});
const fetchUrls = Type.Array(nonEmptyText, {
  minItems: 1,
  description: "URLs to fetch in one call.",
});
const fetchParameters = Type.Object({
  url: Type.Optional(nonEmptyText),
  urls: Type.Optional(fetchUrls),
  mode: Type.Optional(
    Type.Union([Type.Literal("readable"), Type.Literal("raw")], {
      default: "readable",
      description:
        'Use "raw" for the unprocessed body when the target is JSON or the extraction looks wrong.',
    }),
  ),
  offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
});

function errorLine(
  name: string,
  result: { content: Array<{ type: string; text?: string }> },
  theme: Theme,
): Text {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const line =
    text.split("\n").find((l) => /error/i.test(l)) ?? text.split("\n")[0];
  return new Text(theme.fg("error", `  ${name} — ${line ?? "failed"}`), 0, 0);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
    if (event.reason === "startup") sweepDeadClones();
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    cloneCache.clear();
    rmSync(GITHUB_CLONE_DIR, { recursive: true, force: true });
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web. Each result is a title, a URL, and a snippet, so fetch a result when the snippet does not settle the question. The current year is ${new Date().getFullYear()}; put it in the query when recency matters.`,
    promptSnippet: "Search the web for external facts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    renderResult(result, _options, theme: Theme, context) {
      if (context.isError) return errorLine("web_search", result, theme);
      const d = result.details as
        | { queries?: string[]; totalResults?: number }
        | undefined;
      return new Text(
        theme.fg(
          "dim",
          `  web_search "${d?.queries?.join(", ") ?? ""}" — ${d?.totalResults ?? 0} results`,
        ),
        0,
        0,
      );
    },
    parameters: searchParameters,
    outputSchema: Type.Object({
      queries: Type.Array(
        Type.Object({
          query: Type.String(),
          results: Type.Array(
            Type.Object({
              title: Type.String(),
              url: Type.String(),
              content: Type.String(),
            }),
          ),
          error: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
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
          isError: true,
        };
      }
      const numResults = Math.min(
        Math.max(Math.floor(params.numResults ?? 5), 1),
        10,
      );

      const jev = await findJev(ctx);
      const fetchCount = jev
        ? Math.min(numResults * 2, RERANK_MAX_CANDIDATES)
        : numResults;

      const queryResults = await mapLimit(queryList, 4, async (query) => {
        try {
          const { results, provider } = await runSearch(
            query,
            fetchCount,
            signal,
          );
          const ranked = (
            await rerankResults(ctx, jev, query, dedupResults(results), signal)
          ).slice(0, numResults);
          return {
            query,
            results: ranked,
            provider,
            error: null as string | null,
          };
        } catch (err) {
          return {
            query,
            results: [] as SearchResult[],
            provider: "none",
            error: errMsg(err),
          };
        }
      });

      let output = "";
      let totalResults = 0;
      const fellBack = queryResults.some((r) => r.provider === "duckduckgo");
      if (fellBack)
        output +=
          "Note: fallback search for at least one query. Snippets are shorter than usual, so fetch a result before concluding.\n\n";
      const seen = new Map<string, Set<string>>();
      const structured: {
        query: string;
        results: { title: string; url: string; content: string }[];
        error: string | null;
      }[] = [];
      for (const { query, results: raw, error } of queryResults) {
        if (queryList.length > 1) output += `## Query: "${query}"\n\n`;
        if (error) {
          structured.push({ query, results: [], error });
          output += `0 results (error: ${error})\n\n`;
          continue;
        }
        const results = dedupResults(raw, seen);
        structured.push({
          query,
          results: results.map(({ title, url, content }) => ({
            title,
            url,
            content,
          })),
          error: null,
        });
        totalResults += results.length;
        if (results.length === 0) {
          output += "0 results.\n\n";
          continue;
        }
        output +=
          results
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 400).replace(/\s+/g, " ")}`,
            )
            .join("\n\n") + "\n\n";
      }

      return {
        content: [
          {
            type: "text",
            text:
              output.trim() ||
              `0 results across ${queryList.length} quer${queryList.length === 1 ? "y" : "ies"}.`,
          },
        ],
        details: {
          queries: queryList,
          totalResults,
          providers: [...new Set(queryResults.map((r) => r.provider))],
        },
        structuredContent: { queries: structured },
        ...(queryResults.every((r) => r.error) ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch web content as markdown. A GitHub code link returns a local path to read files from. A GitHub issue or pull link returns the thread with its comments. A video link returns the transcript. For PR diffs, checks, or review threads, use github_pr instead.",
    promptSnippet: "Read a web page, GitHub link, or video transcript",
    annotations: { readOnlyHint: true, openWorldHint: true },
    renderResult(result, _options, theme: Theme, context) {
      if (context.isError) return errorLine("fetch_content", result, theme);
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
    parameters: fetchParameters,
    outputSchema: Type.Object({
      pages: Type.Array(
        Type.Object({
          url: Type.String(),
          title: Type.String(),
          content: Type.String({ description: "Markdown, or a local path" }),
          error: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
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
          isError: true,
        };
      }
      const mode = params.mode === "raw" ? "raw" : "readable";
      const offset = Math.max(Math.floor(params.offset ?? 0), 0);

      const results = await mapLimit(urlList, 3, async (url) => {
        try {
          const { title, content } = await fetchOneCached(url, signal, mode);
          return {
            url,
            title,
            content: withContinuationFooter(content, offset, url),
            error: null as string | null,
          };
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
        structuredContent: { pages: results },
        ...(results.every((r) => r.error) ? { isError: true } : {}),
      };
    },
  });
}
