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

function isBot(login: string, typename?: string): boolean {
  if (typename === "Bot") return true;
  const l = login.toLowerCase();
  if (l.endsWith("[bot]")) return true;
  if (["dependabot", "github-actions", "codecov", "sonarcloud"].includes(l))
    return true;
  return l.includes("coderabbit") || l.includes("sonarqube");
}

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

type Author = { login: string; __typename: string } | null;
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
type IssueComment = { isMinimized: boolean; author: Author; body: string };
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
      comments(last:100){ totalCount nodes{ isMinimized author{login __typename} body } }
      reviews(last:100){ totalCount nodes{
        id isMinimized author{login __typename} state body submittedAt comments{ totalCount }
      } }
      reviewThreads(last:100){ totalCount nodes{
        id isResolved isOutdated path line
        comments(first:100){ totalCount nodes{
          id isMinimized author{login __typename} body pullRequestReview{ id }
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

type HideTarget = {
  id: string;
  label: string;
  classifier: "RESOLVED" | "OUTDATED";
};

type ReviewVerdict = {
  hide: HideTarget[];
  kept: Review[];
  usage?: Usage;
  note?: string;
};

const HIDE_CONFIDENCE = 0.8;

function reviewLabel(r: Review): string {
  return `review by @${r.author?.login ?? "?"}`;
}

async function judgeReviews(
  ctx: ExtensionContext,
  candidates: Review[],
  all: Review[],
  signal?: AbortSignal,
): Promise<ReviewVerdict> {
  if (!candidates.length) return { hide: [], kept: [] };
  const keepAll = (note: string, usage?: Usage): ReviewVerdict => ({
    hide: [],
    kept: candidates,
    usage,
    note: `${note}, so every review with a body was kept.`,
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

  const timeline = all
    .filter((r) => r.state !== "PENDING")
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const questions: Record<string, ClassifierBoolQuestion> = {};
  for (const r of candidates) {
    const i = timeline.indexOf(r);
    questions[`own${i}`] = {
      type: "bool",
      instructions: `Does \`reviews[${i}].body\` raise a finding of its own?`,
      criteria: {
        true: "The body names a problem, risk, question, or requested change, including nitpicks or comments outside the diff.",
        false:
          "The body only approves, summarizes or counts its inline comments, or reports tool status.",
      },
    };
    if (
      timeline.slice(i + 1).some((l) => l.author?.login === r.author?.login)
    ) {
      questions[`replaced${i}`] = {
        type: "bool",
        instructions: `Does a later review by \`reviews[${i}].author\` replace everything that \`reviews[${i}].body\` says?`,
        criteria: {
          true: "Every finding and status in the body is repeated, updated, or withdrawn in a later review by the same author.",
          false:
            "At least one finding or status in the body appears in no later review by the same author.",
        },
      };
    }
  }

  const timeout = AbortSignal.timeout(15_000);
  let result: Awaited<ReturnType<typeof ctx.modelRegistry.classify>>;
  try {
    result = await ctx.modelRegistry.classify(
      jev,
      {
        state: {
          reviews: timeline.map((r) => ({
            author: r.author?.login ?? "?",
            submittedAt: r.submittedAt,
            state: r.state,
            body: cleanBody(r.body, 1536),
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
  const verdict: ReviewVerdict = { hide: [], kept: [], usage: result.usage };
  for (const r of candidates) {
    const i = timeline.indexOf(r);
    const replaced = probability(`replaced${i}`) ?? 0;
    const own = probability(`own${i}`) ?? 1;
    if (replaced >= HIDE_CONFIDENCE) {
      verdict.hide.push({
        id: r.id,
        label: reviewLabel(r),
        classifier: "OUTDATED",
      });
    } else if (own <= 1 - HIDE_CONFIDENCE) {
      verdict.hide.push({
        id: r.id,
        label: reviewLabel(r),
        classifier: "RESOLVED",
      });
    } else {
      verdict.kept.push(r);
    }
  }
  return verdict;
}

async function resolveAndHide(
  ctx: ExtensionContext,
  owner: string,
  repo: string,
  num: number,
  requestedIds: string[],
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!owner || !repo) {
    return fail("github_pr: resolve needs owner/repo — pass `repo`.");
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
  const resolved = await mutateEach(
    threads.filter((t) => !t.isResolved),
    (t) => [
      "-f",
      "query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }",
      "-f",
      `id=${t.id}`,
    ],
    signal,
  );
  const resolvedNow = new Set(resolved.ok.map((t) => t.id));
  const closed = threads.filter((t) => t.isResolved || resolvedNow.has(t.id));

  const settledPerReview = new Map<string, number>();
  for (const c of closed.flatMap((t) => t.comments.nodes)) {
    const id = c.pullRequestReview?.id;
    if (id) settledPerReview.set(id, (settledPerReview.get(id) ?? 0) + 1);
  }
  const requested = new Set(requestedIds);
  const settledReviews = pr.reviews.nodes.filter(
    (r) =>
      !r.isMinimized &&
      r.state !== "PENDING" &&
      !requested.has(r.id) &&
      (settledPerReview.get(r.id) ?? 0) === r.comments.totalCount,
  );
  const verdict = await judgeReviews(
    ctx,
    settledReviews.filter((r) => hasText(r.body)),
    pr.reviews.nodes,
    signal,
  );

  const targets = new Map<string, HideTarget>();
  for (const t of closed) {
    for (const c of t.comments.nodes) {
      if (c.isMinimized) continue;
      targets.set(c.id, {
        id: c.id,
        label: `\`${t.path}${t.line ? `:${t.line}` : ""}\` comment by @${c.author?.login ?? "?"}`,
        classifier: "RESOLVED",
      });
    }
  }
  for (const r of settledReviews.filter((r) => !hasText(r.body))) {
    targets.set(r.id, {
      id: r.id,
      label: reviewLabel(r),
      classifier: "OUTDATED",
    });
  }
  for (const t of verdict.hide) targets.set(t.id, t);
  for (const id of requestedIds) {
    targets.set(id, { id, label: `\`${id}\``, classifier: "OUTDATED" });
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

  const loc = (t: Thread) => `${t.path}${t.line ? `:${t.line}` : ""}`;
  const attempted =
    resolved.ok.length + resolved.failed.length + resolved.skipped;
  const out = [
    `# PR #${num}: resolved ${resolved.ok.length}/${attempted} thread(s), hid ${hidden.ok.length}/${targets.size} item(s)`,
  ];
  for (const t of resolved.ok) out.push(`- ✅ \`${loc(t)}\``);
  for (const f of resolved.failed)
    out.push(`- ⚠️ resolve \`${loc(f.item)}\`: ${f.error}`);
  for (const f of hidden.failed)
    out.push(`- ⚠️ hide ${f.item.label}: ${f.error}`);
  const skipped = resolved.skipped + hidden.skipped;
  if (skipped) out.push(`- ⏹ ${skipped} not attempted: aborted`);

  const unseenThreads = pr.reviewThreads.totalCount - threads.length;
  if (unseenThreads > 0)
    out.push(
      `\n${unseenThreads} older thread(s) were not checked. Resolve them on GitHub.`,
    );
  if (verdict.note) out.push(`\n${verdict.note}`);
  if (verdict.kept.length) {
    out.push(`\n## Kept reviews`);
    for (const r of verdict.kept) {
      const line = firstLine(stripHtmlComments(r.body)).slice(0, 120);
      out.push(
        `- \`${r.id}\` @${r.author?.login ?? "?"} (${r.state}): ${line}`,
      );
    }
    out.push(
      `\nIf a kept review no longer holds, call resolve again with its id in \`hide\`.`,
    );
  }

  const failures = resolved.failed.length + hidden.failed.length;
  return {
    content: [{ type: "text", text: out.join("\n") }],
    structuredContent: prValue({
      pr: num,
      resolved: resolved.ok.length,
      hidden: hidden.ok.length,
      keptReviews: verdict.kept.map((r) => ({
        id: r.id,
        author: r.author?.login ?? "?",
        state: r.state,
      })),
    }),
    details: {
      summary:
        `PR #${num} · resolved ${resolved.ok.length} thread(s) · hid ${hidden.ok.length} item(s)` +
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
  includeBots: Type.Optional(
    Type.Boolean({ description: "Keep bot comments." }),
  ),
  includeResolved: Type.Optional(
    Type.Boolean({
      description: "Keep resolved and outdated review threads.",
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
        "report (default) returns the PR as markdown. resolve marks every unresolved review thread as resolved on GitHub, without a reply, and hides review content that no longer holds. Call resolve as soon as you have fixed the review comments locally. Do not wait for a commit, push, or merge.",
    }),
  ),
  hide: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "With action resolve: ids from the resolve report's kept reviews to hide as outdated.",
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
    Type.Array(Type.Object({ author: Author, body: Type.String() })),
  ),
  reviews: Type.Optional(
    Type.Array(
      Type.Object({
        author: Author,
        state: Type.String(),
        body: Type.String(),
      }),
    ),
  ),
  threads: Type.Optional(
    Type.Array(
      Type.Object({
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
  keptReviews: Type.Optional(
    Type.Array(
      Type.Object({ id: Type.String(), author: Author, state: Type.String() }),
    ),
  ),
});
type PrValue = Static<typeof outputSchema>;
const prValue = (v: PrValue): JsonValue => v as JsonValue;

export default function (pi: ExtensionAPI) {
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
      "Fetch a GitHub PR (URL or number) as markdown: metadata, description, changed files, failing checks, and unresolved review threads, without bot noise. Use instead of `gh pr view`. Pass `select` to fetch just one section, or `action: resolve` after a fix to resolve every open review thread and hide stale review content.",
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

      if (a.action === "resolve") {
        return resolveAndHide(ctx, glOwner, glRepo, num, a.hide ?? [], signal);
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

          const comments = pr.comments.nodes.filter(
            (c) =>
              !c.isMinimized &&
              (a.includeBots ||
                !isBot(c.author?.login ?? "", c.author?.__typename)),
          );
          nComments = comments.length;
          value.comments = comments.map((c) => ({
            author: c.author?.login ?? "?",
            body: cleanBody(c.body, 2 * 1024),
          }));
          if (comments.length) {
            out.push(`\n## Comments`);
            for (const c of comments) {
              out.push(
                `**@${c.author?.login ?? "?"}**: ${cleanBody(c.body, 2 * 1024)}`,
              );
            }
          }
          const unfetchedC = pr.comments.totalCount - pr.comments.nodes.length;
          if (unfetchedC > 0)
            out.push(`\n_(+${unfetchedC} earlier comment(s) not fetched)_`);

          const reviews = pr.reviews.nodes.filter(
            (r) => !r.isMinimized && r.state !== "PENDING" && hasText(r.body),
          );
          nReviews = reviews.length;
          value.reviews = reviews.map((r) => ({
            author: r.author?.login ?? "?",
            state: r.state,
            body: cleanBody(r.body, 2 * 1024),
          }));
          if (reviews.length) {
            out.push(`\n## Review bodies`);
            for (const r of reviews) {
              out.push(
                `**@${r.author?.login ?? "?"}** (${r.state}): ${cleanBody(r.body, 2 * 1024)}`,
              );
            }
          }
          const unfetchedR = pr.reviews.totalCount - pr.reviews.nodes.length;
          if (unfetchedR > 0)
            out.push(`\n_(+${unfetchedR} earlier review(s) not fetched)_`);

          const threads = pr.reviewThreads.nodes
            .filter(
              (t) => a.includeResolved || (!t.isResolved && !t.isOutdated),
            )
            .map((t) => ({
              ...t,
              visible: t.comments.nodes.filter((c) => !c.isMinimized),
            }))
            .filter((t) => t.visible.length);
          nThreads = threads.length;
          value.threads = threads.map((t) => ({
            path: t.path,
            line: t.line ?? null,
            comments: t.visible.map((c) => ({
              author: c.author?.login ?? "?",
              body: cleanBody(c.body, 2 * 1024),
            })),
          }));
          if (threads.length) {
            out.push(`\n## Review comments (unresolved)`);
            for (const t of threads) {
              out.push(
                `\n${`\`${t.path}\`${t.line ? `:${t.line}` : ""}`}${
                  (t.isResolved ? " [resolved]" : "") +
                  (t.isOutdated ? " [outdated]" : "")
                }`,
              );
              for (const c of t.visible) {
                out.push(
                  `- **@${c.author?.login ?? "?"}**: ${cleanBody(c.body, 2 * 1024)}`,
                );
              }
              const unfetched = t.comments.totalCount - t.comments.nodes.length;
              if (unfetched > 0)
                out.push(`- _(+${unfetched} later comment(s) not fetched)_`);
            }
          }
          if (reviews.length || threads.some((t) => !t.isResolved)) {
            out.push(
              `\n**Next:** after you fix these review comments, call \`github_pr\` with \`pr: "${m.url}"\` and \`action: "resolve"\`.`,
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
        out.push(
          `\n_(comments unavailable: ${firstLine(gql.stderr)})_`,
        );
      } else if (wantComments) {
        out.push(`\n_(comments unavailable: pass \`repo\` as owner/repo)_`);
      }

      if (!select && wantDiff && diff.code !== 0) {
        out.push(
          `\n_(diff unavailable: ${firstLine(diff.stderr)})_`,
        );
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
