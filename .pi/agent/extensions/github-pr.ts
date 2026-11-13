import type {
  ClassifierApi,
  ClassifierBoolQuestion,
  ClassifierModel,
  JsonValue,
  Usage,
} from "@earendil-works/pi-ai";
import {
  formatSize,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { run } from "./shared/exec";

const MAX_DIFF_BYTES = 48 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_LISTED_FILES = 200;
// truncateHead applies a 2000-line cap by default. These two budgets are
// byte-only, so disable the line limit rather than add a second one.
const NO_LINE_CAP = Number.MAX_SAFE_INTEGER;

function stripHtmlComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanBody(body: string, maxBytes: number): string {
  const b = stripHtmlComments(
    body.replace(
      /<!--\s*This is an auto-generated comment[\s\S]*?end of auto-generated comment[\s\S]*?-->/gi,
      "",
    ),
  );
  const r = truncateHead(b, { maxBytes, maxLines: NO_LINE_CAP });
  return r.truncated ? `${r.content}\n…[body truncated]` : r.content;
}

function parsePr(pr: string): { number: number; repo?: string } | null {
  const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  const n = pr.trim().replace(/^#/, "");
  if (/^\d+$/.test(n)) return { number: Number(n) };
  return null;
}

type Author = { login: string } | null;
type ThreadComment = {
  id: string;
  isMinimized: boolean;
  author: Author;
  body: string;
  pullRequestReview: { id: string } | null;
};
type Thread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: { totalCount: number; nodes: ThreadComment[] };
};
type IssueComment = {
  id: string;
  isMinimized: boolean;
  author: Author;
  body: string;
  createdAt: string;
};
type Review = {
  id: string;
  isMinimized: boolean;
  author: Author;
  state: string;
  body: string;
  submittedAt: string | null;
  comments: { totalCount: number };
};
type PrData = {
  comments: { totalCount: number; nodes: IssueComment[] };
  reviews: { totalCount: number; nodes: Review[] };
  reviewThreads: { totalCount: number; nodes: Thread[] };
};

const PR_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      comments(last:100){ totalCount nodes{ id isMinimized author{login} body createdAt } }
      reviews(last:100){ totalCount nodes{
        id isMinimized author{login} state body submittedAt comments{ totalCount }
      } }
      reviewThreads(last:100){ totalCount nodes{
        id isResolved isOutdated path line
        comments(first:100){ totalCount nodes{
          id isMinimized author{login} body pullRequestReview{ id }
        } }
      } }
    }
  }
}`;

function queryPr(
  owner: string,
  repo: string,
  num: number,
  signal?: AbortSignal,
  cwd?: string,
) {
  return run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
      "-F",
      `number=${num}`,
    ],
    signal,
    cwd,
  );
}

function parsePrData(stdout: string): PrData {
  return (
    JSON.parse(stdout) as { data: { repository: { pullRequest: PrData } } }
  ).data.repository.pullRequest;
}

function hasText(body: string): boolean {
  return stripHtmlComments(body) !== "";
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0];
}

const MUTATION_CONCURRENCY = 4;

async function mutateEach<T>(
  items: T[],
  graphqlArgs: (item: T) => string[],
  signal?: AbortSignal,
): Promise<{
  ok: T[];
  failed: { item: T; error: string }[];
  skipped: number;
}> {
  const ok: T[] = [];
  const failed: { item: T; error: string }[] = [];
  for (let i = 0; i < items.length; i += MUTATION_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = items.slice(i, i + MUTATION_CONCURRENCY);
    const results = await Promise.all(
      batch.map((item) =>
        run("gh", ["api", "graphql", ...graphqlArgs(item)], signal),
      ),
    );
    results.forEach((r, j) => {
      if (r.code === 0) ok.push(batch[j]);
      else failed.push({ item: batch[j], error: firstLine(r.stderr) });
    });
  }
  return { ok, failed, skipped: items.length - ok.length - failed.length };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

type ToolResult = AgentToolResult<{ summary: string }>;

function fail(msg: string): ToolResult {
  return {
    content: [{ type: "text", text: msg }],
    details: { summary: msg },
    isError: true,
  };
}

type Kind = "thread" | "review" | "comment";
type Seen = { kind: Kind; id: string; lastCommentId?: string };
type PrHandles = {
  byHandle: Map<string, Seen>;
  byId: Map<string, string>;
  next: Record<Kind, number>;
};

const HANDLE_PREFIX: Record<Kind, string> = {
  thread: "t",
  review: "r",
  comment: "c",
};

function newHandles(): PrHandles {
  return {
    byHandle: new Map(),
    byId: new Map(),
    next: { thread: 0, review: 0, comment: 0 },
  };
}

function markSeen(
  h: PrHandles,
  kind: Kind,
  id: string,
  lastCommentId?: string,
): string {
  let handle = h.byId.get(id);
  if (!handle) {
    handle = `${HANDLE_PREFIX[kind]}${++h.next[kind]}`;
    h.byId.set(id, handle);
  }
  h.byHandle.set(handle, { kind, id, lastCommentId });
  return handle;
}

function visibleComments(t: Thread): ThreadComment[] {
  return t.comments.nodes.filter((c) => !c.isMinimized);
}

function lastVisibleId(t: Thread): string | undefined {
  return visibleComments(t).at(-1)?.id;
}

function commentsAfter(t: Thread, seenId?: string): ThreadComment[] {
  const at = t.comments.nodes.findIndex((c) => c.id === seenId);
  return t.comments.nodes.slice(at + 1).filter((c) => !c.isMinimized);
}

function threadLoc(t: Thread): string {
  return `${t.path}${t.line ? `:${t.line}` : ""}`;
}

type Post = {
  kind: "review" | "comment";
  id: string;
  isMinimized: boolean;
  author: Author;
  at: string | null;
  body: string;
  state?: string;
};

function postsOf(pr: PrData): Post[] {
  return [
    ...pr.reviews.nodes
      .filter((r) => r.state !== "PENDING")
      .map(
        (r): Post => ({
          kind: "review",
          id: r.id,
          isMinimized: r.isMinimized,
          author: r.author,
          at: r.submittedAt,
          body: r.body,
          state: r.state,
        }),
      ),
    ...pr.comments.nodes.map(
      (c): Post => ({
        kind: "comment",
        id: c.id,
        isMinimized: c.isMinimized,
        author: c.author,
        at: c.createdAt,
        body: c.body,
      }),
    ),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

function postLabel(p: Post): string {
  return `${p.kind} by @${p.author?.login ?? "?"}`;
}

type Classifier = "RESOLVED" | "OUTDATED";
type Group = "named" | "jev" | "cleanup";
type HideTarget = {
  id: string;
  label: string;
  classifier: Classifier;
  group: Group;
};

type Verdict = {
  hidePosts: Map<string, Classifier>;
  settledThreads: Set<string>;
  usage?: Usage;
  note?: string;
};

const HIDE_CONFIDENCE = 0.8;

async function judge(
  ctx: ExtensionContext,
  posts: Post[],
  timeline: Post[],
  outdatedThreads: Thread[],
  signal?: AbortSignal,
): Promise<Verdict> {
  const verdict: Verdict = { hidePosts: new Map(), settledThreads: new Set() };
  if (!posts.length && !outdatedThreads.length) return verdict;
  const keepAll = (note: string, usage?: Usage): Verdict => ({
    ...verdict,
    usage,
    note: `${note}, so every unseen review, comment, and outdated thread was kept.`,
  });

  let jev: ClassifierModel<ClassifierApi> | undefined;
  try {
    jev = (
      await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe")
    ).find((model) => model.id === "jev-latest");
  } catch {
    jev = undefined;
  }
  if (!jev) return keepAll("No review classifier is available");

  const questions: Record<string, ClassifierBoolQuestion> = {};
  for (const p of posts) {
    const i = timeline.indexOf(p);
    questions[`own${i}`] = {
      type: "bool",
      instructions: `Does \`posts[${i}].body\` raise a finding of its own?`,
      criteria: {
        true: "The body names a problem, risk, question, or requested change, including nitpicks or comments outside the diff.",
        false:
          "The body only approves, summarizes or counts inline comments, or reports tool status.",
      },
    };
    if (
      timeline.slice(i + 1).some((l) => l.author?.login === p.author?.login)
    ) {
      questions[`replaced${i}`] = {
        type: "bool",
        instructions: `Does a later post by \`posts[${i}].author\` replace everything that \`posts[${i}].body\` says?`,
        criteria: {
          true: "Every finding and status in the body is repeated, updated, or withdrawn in a later post by the same author.",
          false:
            "At least one finding or status in the body appears in no later post by the same author.",
        },
      };
    }
  }
  outdatedThreads.forEach((_, k) => {
    questions[`settled${k}`] = {
      type: "bool",
      instructions: `The code under \`threads[${k}]\` changed after its comments. Do its comments show that it needs no more work?`,
      criteria: {
        true: "A comment says the finding is fixed, answered, or withdrawn, or the thread only acknowledges, praises, or reports tool status.",
        false:
          "The thread names a problem, risk, question, or requested change that no comment settles.",
      },
    };
  });

  const timeout = AbortSignal.timeout(15_000);
  let result: Awaited<ReturnType<typeof ctx.modelRegistry.classify>>;
  try {
    result = await ctx.modelRegistry.classify(
      jev,
      {
        state: {
          posts: posts.length
            ? timeline.map((p) => ({
                kind: p.kind,
                author: p.author?.login ?? "?",
                at: p.at,
                ...(p.state ? { state: p.state } : {}),
                body: cleanBody(p.body, 1536),
              }))
            : [],
          threads: outdatedThreads.map((t) => ({
            path: t.path,
            comments: visibleComments(t).map((c) => ({
              author: c.author?.login ?? "?",
              body: cleanBody(c.body, 1536),
            })),
          })),
        },
        questions,
      },
      { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    );
  } catch (err) {
    return keepAll(`The review classifier failed (${String(err)})`);
  }
  if (result.stopReason !== "stop") {
    return keepAll(
      `The review classifier failed (${result.errorMessage ?? result.stopReason})`,
      result.usage,
    );
  }

  const probability = (key: string) => {
    const answer = result.answers[key];
    return answer?.type === "bool" ? answer.probability : undefined;
  };
  verdict.usage = result.usage;
  for (const p of posts) {
    const i = timeline.indexOf(p);
    if ((probability(`replaced${i}`) ?? 0) >= HIDE_CONFIDENCE)
      verdict.hidePosts.set(p.id, "OUTDATED");
    else if ((probability(`own${i}`) ?? 1) <= 1 - HIDE_CONFIDENCE)
      verdict.hidePosts.set(p.id, "RESOLVED");
  }
  outdatedThreads.forEach((t, k) => {
    if ((probability(`settled${k}`) ?? 0) >= HIDE_CONFIDENCE)
      verdict.settledThreads.add(t.id);
  });
  return verdict;
}

type AttentionReason = "changed" | "new" | "outdated";
type Attention = {
  handle: string;
  reason: AttentionReason;
  location: string;
  comments: { author: string; body: string }[];
};

function threadAttention(
  handle: string,
  reason: AttentionReason,
  t: Thread,
  comments: ThreadComment[],
): Attention {
  return {
    handle,
    reason,
    location: threadLoc(t),
    comments: comments.map((c) => ({
      author: c.author?.login ?? "?",
      body: cleanBody(c.body, 2 * 1024),
    })),
  };
}

const ATTENTION_HEADINGS: Record<AttentionReason, string> = {
  changed: "Changed since your report",
  new: "New since your report",
  outdated: "Kept outdated threads",
};

async function resolveHandled(
  ctx: ExtensionContext,
  owner: string,
  repo: string,
  num: number,
  handles: PrHandles | undefined,
  ids: string[],
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!owner || !repo) {
    return fail("github_pr: resolve needs owner/repo — pass `repo`.");
  }
  if (!handles) {
    return fail(
      `github_pr: no report for PR #${num} in this session. Call github_pr with action "report" first.`,
    );
  }
  const gql = await queryPr(owner, repo, num, signal);
  if (gql.code !== 0) {
    return fail(
      `github_pr: could not read PR #${num}: ${firstLine(gql.stderr)}`,
    );
  }
  let pr: PrData;
  try {
    pr = parsePrData(gql.stdout);
  } catch {
    return fail("github_pr: could not parse review threads");
  }

  const threads = pr.reviewThreads.nodes;
  const threadById = new Map(threads.map((t) => [t.id, t]));
  const posts = postsOf(pr);
  const postById = new Map(posts.map((p) => [p.id, p]));

  const errors: string[] = [];
  const alreadyClosed: string[] = [];
  const attention: Attention[] = [];
  const namedThreads: { handle: string; thread: Thread }[] = [];
  const targets = new Map<string, HideTarget>();
  const named = new Set<string>();

  for (const handle of new Set(ids)) {
    const seen = handles.byHandle.get(handle);
    if (!seen) {
      errors.push(`${handle}: unknown handle`);
      continue;
    }
    named.add(seen.id);
    if (seen.kind === "thread") {
      const t = threadById.get(seen.id);
      if (!t) errors.push(`${handle}: not among the last 100 threads`);
      else if (t.isResolved) alreadyClosed.push(handle);
      else if (!commentsAfter(t, seen.lastCommentId).length)
        namedThreads.push({ handle, thread: t });
      continue;
    }
    const p = postById.get(seen.id);
    if (!p) errors.push(`${handle}: not among the last 100 ${seen.kind}s`);
    else if (p.isMinimized) alreadyClosed.push(handle);
    else
      targets.set(p.id, {
        id: p.id,
        label: `${handle} ${postLabel(p)}`,
        classifier: "RESOLVED",
        group: "named",
      });
  }

  const stillOpen: string[] = [];
  for (const [handle, seen] of handles.byHandle) {
    if (seen.kind === "thread") {
      const t = threadById.get(seen.id);
      if (!t || t.isResolved) continue;
      const fresh = commentsAfter(t, seen.lastCommentId);
      if (fresh.length) {
        attention.push(threadAttention(handle, "changed", t, fresh));
        markSeen(handles, "thread", t.id, lastVisibleId(t));
      } else if (!named.has(seen.id)) stillOpen.push(handle);
    } else {
      const p = postById.get(seen.id);
      if (p && !p.isMinimized && !named.has(seen.id)) stillOpen.push(handle);
    }
  }

  const unseenThreads = threads.filter(
    (t) =>
      !t.isResolved && !handles.byId.has(t.id) && visibleComments(t).length > 0,
  );
  const outdatedUnseen = unseenThreads.filter((t) => t.isOutdated);
  const unseenPosts = posts.filter(
    (p) => !p.isMinimized && hasText(p.body) && !handles.byId.has(p.id),
  );

  const reviewsSettledBy = (closed: Thread[]) => {
    const settledPerReview = new Map<string, number>();
    for (const c of closed.flatMap((t) => t.comments.nodes)) {
      const id = c.pullRequestReview?.id;
      if (id) settledPerReview.set(id, (settledPerReview.get(id) ?? 0) + 1);
    }
    return new Set(
      pr.reviews.nodes
        .filter(
          (r) => (settledPerReview.get(r.id) ?? 0) === r.comments.totalCount,
        )
        .map((r) => r.id),
    );
  };
  const mayClose = new Set([
    ...namedThreads.map((n) => n.thread.id),
    ...outdatedUnseen.map((t) => t.id),
  ]);
  const maySettle = reviewsSettledBy(
    threads.filter((t) => t.isResolved || mayClose.has(t.id)),
  );
  const verdict = await judge(
    ctx,
    unseenPosts.filter((p) => p.kind === "comment" || maySettle.has(p.id)),
    posts,
    outdatedUnseen,
    signal,
  );

  const resolveList: { handle?: string; thread: Thread; group: Group }[] = [
    ...namedThreads.map((n) => ({ ...n, group: "named" as const })),
    ...outdatedUnseen
      .filter((t) => verdict.settledThreads.has(t.id))
      .map((thread) => ({ thread, group: "jev" as const })),
  ];
  const resolved = await mutateEach(
    resolveList,
    ({ thread }) => [
      "-f",
      "query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }",
      "-f",
      `id=${thread.id}`,
    ],
    signal,
  );
  const resolvedNow = new Set(resolved.ok.map((r) => r.thread.id));
  const closed = threads.filter((t) => t.isResolved || resolvedNow.has(t.id));
  const settled = reviewsSettledBy(closed);

  for (const t of closed) {
    for (const c of visibleComments(t)) {
      targets.set(c.id, {
        id: c.id,
        label: `\`${threadLoc(t)}\` comment by @${c.author?.login ?? "?"}`,
        classifier: "RESOLVED",
        group: "cleanup",
      });
    }
  }
  for (const r of pr.reviews.nodes) {
    if (
      !r.isMinimized &&
      r.state !== "PENDING" &&
      !hasText(r.body) &&
      settled.has(r.id)
    )
      targets.set(r.id, {
        id: r.id,
        label: `review by @${r.author?.login ?? "?"}`,
        classifier: "OUTDATED",
        group: "cleanup",
      });
  }
  const newPosts: Post[] = [];
  for (const p of unseenPosts) {
    const classifier = verdict.hidePosts.get(p.id);
    if (classifier && (p.kind === "comment" || settled.has(p.id)))
      targets.set(p.id, {
        id: p.id,
        label: postLabel(p),
        classifier,
        group: "jev",
      });
    else newPosts.push(p);
  }

  const hidden = await mutateEach(
    [...targets.values()],
    (t) => [
      "-f",
      "query=mutation($id:ID!,$c:ReportedContentClassifiers!){ minimizeComment(input:{subjectId:$id,classifier:$c}){ minimizedComment{ isMinimized } } }",
      "-f",
      `id=${t.id}`,
      "-f",
      `c=${t.classifier}`,
    ],
    signal,
  );

  for (const t of unseenThreads) {
    if (t.isOutdated && verdict.settledThreads.has(t.id)) continue;
    const handle = markSeen(handles, "thread", t.id, lastVisibleId(t));
    attention.push(
      threadAttention(
        handle,
        t.isOutdated ? "outdated" : "new",
        t,
        visibleComments(t),
      ),
    );
  }
  for (const p of newPosts) {
    const handle = markSeen(handles, p.kind, p.id);
    attention.push({
      handle,
      reason: "new",
      location: postLabel(p),
      comments: [
        {
          author: p.author?.login ?? "?",
          body: cleanBody(p.body, 2 * 1024),
        },
      ],
    });
  }

  const closedByAgent = [
    ...resolved.ok
      .filter((r) => r.group === "named")
      .map((r) => `${r.handle} \`${threadLoc(r.thread)}\``),
    ...hidden.ok.filter((t) => t.group === "named").map((t) => t.label),
  ];
  const count = (group: Group) =>
    hidden.ok.filter((t) => t.group === group).length;
  const jevResolved = resolved.ok.filter((r) => r.group === "jev").length;
  const skipped = resolved.skipped + hidden.skipped;
  const failures = resolved.failed.length + hidden.failed.length;

  const out = [
    `# PR #${num}: resolved ${resolved.ok.length} thread(s), hid ${hidden.ok.length} item(s)`,
  ];
  for (const line of closedByAgent) out.push(`- ✅ ${line}`);
  if (jevResolved || count("jev"))
    out.push(
      `Jev resolved ${jevResolved} outdated thread(s) and hid ${count("jev")} summary item(s).`,
    );
  if (count("cleanup"))
    out.push(`Cleanup hid ${count("cleanup")} resolved item(s).`);
  if (verdict.note) out.push(verdict.note);
  if (alreadyClosed.length)
    out.push(`Already closed: ${alreadyClosed.join(", ")}`);
  if (stillOpen.length)
    out.push(`Still open (you skipped): ${stillOpen.join(", ")}`);
  for (const e of errors) out.push(`- ⚠️ ${e}`);
  for (const f of resolved.failed)
    out.push(
      `- ⚠️ resolve ${f.item.handle ?? ""} \`${threadLoc(f.item.thread)}\`: ${f.error}`,
    );
  for (const f of hidden.failed)
    out.push(`- ⚠️ hide ${f.item.label}: ${f.error}`);
  if (skipped) out.push(`- ⏹ ${skipped} not attempted: aborted`);
  const unfetched = pr.reviewThreads.totalCount - threads.length;
  if (unfetched > 0)
    out.push(
      `${unfetched} older thread(s) were not checked. Resolve them on GitHub.`,
    );

  for (const reason of ["changed", "new", "outdated"] as const) {
    const items = attention.filter((a) => a.reason === reason);
    if (!items.length) continue;
    out.push(`\n## ${ATTENTION_HEADINGS[reason]}`);
    for (const a of items) {
      out.push(`\n\`${a.handle}\` ${a.location}`);
      for (const c of a.comments) out.push(`- **@${c.author}**: ${c.body}`);
    }
  }

  const open =
    stillOpen.length + attention.length + errors.length + failures + skipped;
  out.push(
    open
      ? `\nHandle the items above, then call resolve again with their handles in \`ids\`.`
      : `\nNothing is open.`,
  );

  return {
    content: [{ type: "text", text: out.join("\n") }],
    structuredContent: prValue({
      pr: num,
      resolved: resolved.ok.length,
      hidden: hidden.ok.length,
      closed: closedByAgent,
      stillOpen,
      attention,
    }),
    details: {
      summary:
        `PR #${num} · resolved ${resolved.ok.length} thread(s) · hid ${hidden.ok.length} item(s)` +
        (open ? ` · ${stillOpen.length + attention.length} open` : "") +
        (failures ? ` · ${failures} failed` : "") +
        (skipped ? ` · ${skipped} skipped` : ""),
    },
    usage: verdict.usage,
    ...(failures || skipped ? { isError: true } : {}),
  };
}

const params = Type.Object({
  pr: Type.String({
    description: "PR URL (https://github.com/owner/repo/pull/123) or number",
  }),
  repo: Type.Optional(
    Type.String({
      description:
        "owner/repo. Inferred from a URL; required for a bare number outside a repo dir.",
    }),
  ),
  diff: Type.Optional(
    Type.Boolean({
      description:
        "Include the unified diff. Leave it off when the PR branch is checked out locally, because reading the files is cheaper.",
    }),
  ),
  select: Type.Optional(
    Type.Enum(["files", "checks", "comments", "diff"], {
      description:
        "Return only this section, which is cheaper than the full report.",
    }),
  ),
  action: Type.Optional(
    Type.Enum(["report", "resolve"], {
      description:
        "report (default) returns the PR as markdown, with a handle such as t1, r1, or c1 on each review thread, review, and comment. resolve closes only the items whose handles you pass in `ids`, without a reply. Items you skip, and items that changed or arrived after the report, stay open and are returned. Call resolve after you handle every item in the latest report, and again until it reports nothing open. Do not wait for a commit, push, or merge.",
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "With action resolve: handles of every item you fixed, answered, or found to need no action.",
    }),
  ),
});

const Author = Type.String({ description: "GitHub login" });
const outputSchema = Type.Object({
  pr: Type.Number(),
  url: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  failingChecks: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), status: Type.String() })),
  ),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String(),
        additions: Type.Number(),
        deletions: Type.Number(),
      }),
    ),
  ),
  comments: Type.Optional(
    Type.Array(
      Type.Object({
        handle: Type.String(),
        author: Author,
        body: Type.String(),
      }),
    ),
  ),
  reviews: Type.Optional(
    Type.Array(
      Type.Object({
        handle: Type.String(),
        author: Author,
        state: Type.String(),
        body: Type.String(),
      }),
    ),
  ),
  threads: Type.Optional(
    Type.Array(
      Type.Object({
        handle: Type.String(),
        path: Type.String(),
        line: Type.Union([Type.Number(), Type.Null()]),
        comments: Type.Array(
          Type.Object({ author: Author, body: Type.String() }),
        ),
      }),
    ),
  ),
  diff: Type.Optional(Type.String()),
  resolved: Type.Optional(Type.Number()),
  hidden: Type.Optional(Type.Number()),
  closed: Type.Optional(Type.Array(Type.String())),
  stillOpen: Type.Optional(Type.Array(Type.String())),
  attention: Type.Optional(
    Type.Array(
      Type.Object({
        handle: Type.String(),
        reason: Type.Enum(["changed", "new", "outdated"]),
        location: Type.String(),
        comments: Type.Array(
          Type.Object({ author: Author, body: Type.String() }),
        ),
      }),
    ),
  ),
});
type PrValue = Static<typeof outputSchema>;
const prValue = (v: PrValue): JsonValue => v as JsonValue;

export default function (pi: ExtensionAPI) {
  const handlesByPr = new Map<string, PrHandles>();
  pi.on("session_start", () => handlesByPr.clear());

  pi.on("input", (event) => {
    const active = pi.getActiveTools();
    if (
      !active.includes("github_pr") &&
      /\b(prs?|pull requests?|pulls?\/\d+|reviews?|ci|checks?)\b/i.test(
        event.text,
      )
    )
      pi.setActiveTools([...active, "github_pr"]);
    return { action: "continue" };
  });

  pi.registerTool<typeof params, { summary: string }>({
    name: "github_pr",
    label: "GitHub PR",
    exposure: "deferred",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    renderResult(result, _options, theme: Theme) {
      return new Text(
        theme.fg("dim", `  ${result.details?.summary ?? "github_pr"}`),
        0,
        0,
      );
    },
    description:
      "Fetch a GitHub PR (URL or number) as markdown: metadata, description, changed files, failing checks, and unresolved review threads, including bot reviewers. Use instead of `gh pr view`. Pass `select` to fetch just one section, or `action: resolve` with the handles of the items you handled to close them on GitHub.",
    parameters: params,
    outputSchema,
    async execute(_id, a, signal, _onUpdate, ctx) {
      const parsed = parsePr(a.pr);
      if (!parsed)
        return fail(
          `github_pr: could not parse "${a.pr}" as a PR URL or number`,
        );
      const repo = a.repo ?? parsed.repo;
      const num = parsed.number;
      const wantDiff = a.diff === true || a.select === "diff";
      const select = a.select;

      const repoArgs = repo ? ["--repo", repo] : [];

      let glOwner = "";
      let glRepo = "";
      if (repo?.includes("/")) {
        [glOwner, glRepo] = repo.split("/");
      } else {
        const r = await run(
          "gh",
          [
            "repo",
            "view",
            "--json",
            "owner,name",
            "-q",
            '.owner.login+"/"+.name',
          ],
          signal,
          ctx.cwd,
        );
        if (r.code === 0 && r.stdout.includes("/")) {
          [glOwner, glRepo] = r.stdout.trim().split("/");
        }
      }

      const prKey = `${glOwner}/${glRepo}#${num}`;
      if (a.action === "resolve") {
        return resolveHandled(
          ctx,
          glOwner,
          glRepo,
          num,
          handlesByPr.get(prKey),
          a.ids ?? [],
          signal,
        );
      }

      const wantComments = !select || select === "comments";
      const [meta, diff, gql] = await Promise.all([
        run(
          "gh",
          [
            "pr",
            "view",
            String(num),
            ...repoArgs,
            "--json",
            "number,title,state,isDraft,baseRefName,headRefName,author,body,labels,additions,deletions,changedFiles,url,mergeable,reviewDecision,files,statusCheckRollup",
          ],
          signal,
          ctx.cwd,
        ),
        wantDiff
          ? run("gh", ["pr", "diff", String(num), ...repoArgs], signal, ctx.cwd)
          : Promise.resolve({ stdout: "", stderr: "", code: 0 }),
        wantComments && glOwner && glRepo
          ? queryPr(glOwner, glRepo, num, signal, ctx.cwd)
          : Promise.resolve(undefined),
      ]);

      if (meta.code !== 0)
        return fail(
          `github_pr: gh pr view failed: ${meta.stderr.trim() || meta.stdout.trim()}`,
        );
      if (select === "diff" && diff.code !== 0)
        return fail(
          `github_pr: gh pr diff failed: ${diff.stderr.trim() || diff.stdout.trim()}`,
        );
      if (select === "comments" && gql?.code !== 0)
        return fail(
          gql
            ? `github_pr: comments query failed: ${firstLine(gql.stderr)}`
            : "github_pr: comments need owner/repo — pass `repo`.",
        );

      const m = JSON.parse(meta.stdout) as {
        number: number;
        title: string;
        state: string;
        isDraft: boolean;
        baseRefName: string;
        headRefName: string;
        author: { login: string } | null;
        body: string;
        labels: { name: string }[];
        additions: number;
        deletions: number;
        changedFiles: number;
        url: string;
        mergeable: string;
        reviewDecision: string;
        files: {
          path: string;
          additions: number;
          deletions: number;
          changeType: string;
        }[];
        statusCheckRollup:
          | {
              name?: string;
              context?: string;
              conclusion?: string;
              state?: string;
            }[]
          | null;
      };

      const out: string[] = [];
      const value: PrValue = { pr: m.number, url: m.url, state: m.state };

      if (!select) {
        out.push(`# PR #${m.number}: ${m.title}`);
        out.push(m.url);
        out.push(
          `**${m.state}${m.isDraft ? " (draft)" : ""}** · \`${m.baseRefName}\` ← \`${m.headRefName}\` · @${m.author?.login ?? "?"} · ${m.mergeable}${m.reviewDecision ? `, ${m.reviewDecision}` : ""}`,
        );
        out.push(
          `+${fmt(m.additions)} / −${fmt(m.deletions)} across ${m.changedFiles} file(s)` +
            (m.labels.length
              ? ` · labels: ${m.labels.map((l) => l.name).join(", ")}`
              : ""),
        );

        const body = cleanBody(m.body || "", 6 * 1024);
        if (body) out.push(`\n## Description\n${body}`);
      }

      const rollup =
        !select || select === "checks" ? (m.statusCheckRollup ?? []) : [];
      if (rollup.length) {
        const norm = rollup.map((c) => ({
          name: c.name || c.context || "check",
          status: (c.conclusion || c.state || "").toUpperCase(),
        }));
        const bad = norm.filter(
          (c) =>
            !["SUCCESS", "NEUTRAL", "SKIPPED", "SKIPPING"].includes(c.status),
        );
        const counts: Record<string, number> = {};
        for (const c of norm) counts[c.status] = (counts[c.status] || 0) + 1;
        value.failingChecks = bad;
        out.push(
          `\n## Checks (${Object.entries(counts)
            .map(([k, v]) => `${v} ${k.toLowerCase()}`)
            .join(", ")})`,
        );
        if (bad.length) {
          for (const c of bad) out.push(`- ⚠️ ${c.name}: ${c.status}`);
        } else {
          out.push(
            `- all ${
              norm.filter((c) =>
                ["SUCCESS", "NEUTRAL", "SKIPPED", "SKIPPING"].includes(
                  c.status,
                ),
              ).length
            } passing/skipped`,
          );
        }
      }

      if ((!select || select === "files") && m.files?.length) {
        value.files = m.files.map(({ path, additions, deletions }) => ({
          path,
          additions,
          deletions,
        }));
        out.push(`\n## Files`);
        for (const f of m.files.slice(0, MAX_LISTED_FILES)) {
          out.push(
            `- \`${f.path}\` +${f.additions}/−${f.deletions} (${f.changeType.toLowerCase()})`,
          );
        }
        if (m.files.length > MAX_LISTED_FILES)
          out.push(`- _(+${m.files.length - MAX_LISTED_FILES} more files)_`);
      }

      let nComments = 0;
      let nReviews = 0;
      let nThreads = 0;
      if (gql?.code === 0 && gql.stdout) {
        try {
          const pr = parsePrData(gql.stdout);
          const handles = handlesByPr.get(prKey) ?? newHandles();
          handlesByPr.set(prKey, handles);

          const comments = pr.comments.nodes
            .filter((c) => !c.isMinimized && hasText(c.body))
            .map((c) => ({
              handle: markSeen(handles, "comment", c.id),
              author: c.author?.login ?? "?",
              body: cleanBody(c.body, 2 * 1024),
            }));
          nComments = comments.length;
          value.comments = comments;
          if (comments.length) {
            out.push(`\n## Comments`);
            for (const c of comments)
              out.push(`\`${c.handle}\` **@${c.author}**: ${c.body}`);
          }
          const unfetchedC = pr.comments.totalCount - pr.comments.nodes.length;
          if (unfetchedC > 0)
            out.push(`\n_(+${unfetchedC} earlier comment(s) not fetched)_`);

          const reviews = pr.reviews.nodes
            .filter(
              (r) => !r.isMinimized && r.state !== "PENDING" && hasText(r.body),
            )
            .map((r) => ({
              handle: markSeen(handles, "review", r.id),
              author: r.author?.login ?? "?",
              state: r.state,
              body: cleanBody(r.body, 2 * 1024),
            }));
          nReviews = reviews.length;
          value.reviews = reviews;
          if (reviews.length) {
            out.push(`\n## Review bodies`);
            for (const r of reviews)
              out.push(
                `\`${r.handle}\` **@${r.author}** (${r.state}): ${r.body}`,
              );
          }
          const unfetchedR = pr.reviews.totalCount - pr.reviews.nodes.length;
          if (unfetchedR > 0)
            out.push(`\n_(+${unfetchedR} earlier review(s) not fetched)_`);

          const threads = pr.reviewThreads.nodes
            .filter(
              (t) =>
                !t.isResolved && !t.isOutdated && visibleComments(t).length,
            )
            .map((t) => ({
              thread: t,
              handle: markSeen(handles, "thread", t.id, lastVisibleId(t)),
              path: t.path,
              line: t.line ?? null,
              comments: visibleComments(t).map((c) => ({
                author: c.author?.login ?? "?",
                body: cleanBody(c.body, 2 * 1024),
              })),
            }));
          nThreads = threads.length;
          value.threads = threads.map(({ thread: _, ...t }) => t);
          if (threads.length) {
            out.push(`\n## Review comments (unresolved)`);
            for (const t of threads) {
              out.push(`\n\`${t.handle}\` \`${threadLoc(t.thread)}\``);
              for (const c of t.comments)
                out.push(`- **@${c.author}**: ${c.body}`);
              const unfetched =
                t.thread.comments.totalCount - t.thread.comments.nodes.length;
              if (unfetched > 0)
                out.push(`- _(+${unfetched} later comment(s) not fetched)_`);
            }
          }
          if (comments.length || reviews.length || threads.length) {
            out.push(
              `\n**Next:** handle every item, then call \`github_pr\` with \`pr: "${m.url}"\`, \`action: "resolve"\`, and \`ids\` set to the handles of the items you fixed, answered, or found to need no action.`,
            );
          }
          const unfetchedT =
            pr.reviewThreads.totalCount - pr.reviewThreads.nodes.length;
          if (unfetchedT > 0)
            out.push(
              `\n_(+${unfetchedT} earlier review thread(s) not fetched — view on GitHub)_`,
            );
        } catch {
          out.push(`\n_(could not parse comments/review threads)_`);
        }
      } else if (gql) {
        out.push(`\n_(comments unavailable: ${firstLine(gql.stderr)})_`);
      } else if (wantComments) {
        out.push(`\n_(comments unavailable: pass \`repo\` as owner/repo)_`);
      }

      if (!select && wantDiff && diff.code !== 0) {
        out.push(`\n_(diff unavailable: ${firstLine(diff.stderr)})_`);
      } else if ((!select || select === "diff") && wantDiff && diff.stdout) {
        const cut = truncateHead(diff.stdout, {
          maxBytes: MAX_DIFF_BYTES,
          maxLines: NO_LINE_CAP,
        });
        value.diff = cut.content;
        out.push(
          `\n## Diff\n\`\`\`diff\n${cut.content}\n\`\`\`${
            cut.truncated
              ? `\n…[diff truncated at ${formatSize(MAX_DIFF_BYTES)} of ${formatSize(cut.totalBytes)} — read files for full context]`
              : ""
          }`,
        );
      }
      if (out.length === 0) out.push(`No ${select} for PR #${m.number}.`);
      const report = truncateHead(out.join("\n"), {
        maxBytes: MAX_REPORT_BYTES,
        maxLines: NO_LINE_CAP,
      });
      return {
        content: [
          {
            type: "text",
            text: report.truncated
              ? `${report.content}\n…[report truncated at ${formatSize(MAX_REPORT_BYTES)}, pass select to fetch one section]`
              : report.content,
          },
        ],
        structuredContent: prValue(value),
        details: {
          summary: `PR #${m.number} · ${[
            m.state.toLowerCase(),
            `${m.changedFiles} files`,
            nReviews ? `${nReviews} review(s)` : null,
            nThreads ? `${nThreads} review comment(s)` : null,
            nComments ? `${nComments} comment(s)` : null,
          ]
            .filter(Boolean)
            .join(" · ")}`,
        },
      };
    },
  });
}
