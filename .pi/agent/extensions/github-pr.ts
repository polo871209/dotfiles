// github-pr — fetch a PR as signal-only markdown. Drops timeline noise,
// resolved threads, and bot summary comments; keeps metadata, checks, and
// unresolved threads (incl. bot inline findings like CodeRabbit).
//
// Diff is OFF by default: on the PR branch the agent reads local files, which
// serves review and editing in one pass. A diff is only a patch — agent
// re-reads to edit anyway. Pull diff only when code isn't reachable locally.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { run } from "./shared/exec";

const MAX_DIFF_BYTES = 48 * 1024;
const MAX_BODY_BYTES = 6 * 1024;

// Bot authors whose summary comments are noise. "[bot]" suffix covers GitHub
// Apps; the set covers App accounts presenting as normal users.
const BOT_LOGINS = new Set([
  "coderabbitai",
  "dependabot",
  "github-actions",
  "codecov",
  "sonarcloud",
  "sonarqube",
]);

function isBot(login: string, typename?: string): boolean {
  if (typename === "Bot") return true;
  const l = login.toLowerCase();
  if (l.endsWith("[bot]")) return true;
  if (BOT_LOGINS.has(l)) return true;
  return l.includes("coderabbit") || l.includes("sonarqube");
}

// Strip HTML comment fences (fingerprinting, cr-comment markers) from review
// thread bodies, keeping the finding text + proposed diff.
function stripHtmlComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Strip auto-generated blocks (coderabbit release notes etc.) from the PR body.
function cleanBody(body: string): string {
  // Visible text sits between an opening and matching "end of" fence.
  let b = body.replace(
    /<!--\s*This is an auto-generated comment[\s\S]*?end of auto-generated comment[\s\S]*?-->/gi,
    "",
  );
  b = b.replace(/<!--[\s\S]*?-->/g, "");
  b = b.replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(b) > MAX_BODY_BYTES) {
    b = b.slice(0, MAX_BODY_BYTES) + "\n…[body truncated]";
  }
  return b;
}

function parsePr(pr: string): { number: number; repo?: string } | null {
  const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  const n = pr.trim().replace(/^#/, "");
  if (/^\d+$/.test(n)) return { number: Number(n) };
  return null;
}

type Thread = {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { author: { login: string } | null; body: string }[] };
};
type IssueComment = {
  author: { login: string; __typename: string } | null;
  body: string;
};

const GRAPHQL = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      comments(first:100){ totalCount nodes{ author{login __typename} body } }
      reviewThreads(first:100){ totalCount nodes{
        isResolved isOutdated path line
        comments(first:30){ nodes{ author{login} body } }
      } }
    }
  }
}`;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
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
        "Include the unified diff. Default FALSE — the PR branch is usually checked out locally, so read files directly. Set true only when the code isn't reachable locally. Capped at 48KB.",
    }),
  ),
  includeBots: Type.Optional(
    Type.Boolean({ description: "Keep bot comments (default false)" }),
  ),
  includeResolved: Type.Optional(
    Type.Boolean({
      description: "Keep resolved/outdated review threads (default false)",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof params, { summary: string }>({
    name: "github_pr",
    label: "GitHub PR",
    // Keep the TUI quiet: the full markdown goes to the model via `content`,
    // but the terminal only shows a one-line summary from `details`.
    renderResult(result, _options, theme: Theme) {
      const s = result.details?.summary ?? "github_pr";
      return new Text(theme.fg("dim", `  ${s}`), 0, 0);
    },
    description:
      "Fetch a GitHub PR (URL or number) as signal-only markdown: metadata, description, changed files, failing checks, and unresolved review threads. Use instead of `gh pr view`.",
    parameters: params,
    async execute(_id, raw, signal, _onUpdate, _ctx) {
      const a = raw as {
        pr: string;
        repo?: string;
        diff?: boolean;
        includeBots?: boolean;
        includeResolved?: boolean;
      };
      const parsed = parsePr(a.pr);
      if (!parsed) {
        const msg = `github_pr: could not parse "${a.pr}" as a PR URL or number`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { summary: msg },
          error: msg,
        };
      }
      const repo = a.repo ?? parsed.repo;
      const num = parsed.number;
      const wantDiff = a.diff === true;

      const repoArgs = repo ? ["--repo", repo] : [];
      const ownerRepo = repo ?? "";

      const metaFields =
        "number,title,state,isDraft,baseRefName,headRefName,author,body,labels,additions,deletions,changedFiles,url,mergeable,reviewDecision,files,statusCheckRollup";

      // gh graphql needs explicit owner/repo. If only a bare number was given
      // (no URL, no --repo), resolve the cwd's repo.
      let glOwner = "";
      let glRepo = "";
      if (ownerRepo.includes("/")) {
        [glOwner, glRepo] = ownerRepo.split("/");
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
        );
        if (r.code === 0 && r.stdout.includes("/")) {
          [glOwner, glRepo] = r.stdout.trim().split("/");
        }
      }

      const [meta, diff, gql] = await Promise.all([
        run(
          "gh",
          ["pr", "view", String(num), ...repoArgs, "--json", metaFields],
          signal,
        ),
        wantDiff
          ? run("gh", ["pr", "diff", String(num), ...repoArgs], signal)
          : Promise.resolve({ stdout: "", stderr: "", code: 0 }),
        glOwner && glRepo
          ? run(
              "gh",
              [
                "api",
                "graphql",
                "-f",
                `query=${GRAPHQL}`,
                "-F",
                `owner=${glOwner}`,
                "-F",
                `repo=${glRepo}`,
                "-F",
                `number=${num}`,
              ],
              signal,
            )
          : Promise.resolve({
              stdout: "",
              stderr: "skipped (no repo)",
              code: -1,
            }),
      ]);

      if (meta.code !== 0) {
        const msg = `github_pr: gh pr view failed: ${meta.stderr.trim() || meta.stdout.trim()}`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { summary: msg },
          error: msg,
        };
      }

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
      const draft = m.isDraft ? " (draft)" : "";
      out.push(`# PR #${m.number}: ${m.title}`);
      out.push(`${m.url}`);
      const dec = m.reviewDecision ? `, ${m.reviewDecision}` : "";
      out.push(
        `**${m.state}${draft}** · \`${m.baseRefName}\` ← \`${m.headRefName}\` · @${m.author?.login ?? "?"} · ${m.mergeable}${dec}`,
      );
      out.push(
        `+${fmt(m.additions)} / −${fmt(m.deletions)} across ${m.changedFiles} file(s)` +
          (m.labels.length
            ? ` · labels: ${m.labels.map((l) => l.name).join(", ")}`
            : ""),
      );

      const body = cleanBody(m.body || "");
      if (body) out.push(`\n## Description\n${body}`);

      // Checks: summarize counts, list only non-passing.
      const rollup = m.statusCheckRollup ?? [];
      if (rollup.length) {
        const norm = rollup.map((c) => ({
          name: c.name || c.context || "check",
          status: (c.conclusion || c.state || "").toUpperCase(),
        }));
        const passing = norm.filter((c) =>
          ["SUCCESS", "NEUTRAL", "SKIPPED", "SKIPPING"].includes(c.status),
        );
        const bad = norm.filter(
          (c) =>
            !["SUCCESS", "NEUTRAL", "SKIPPED", "SKIPPING"].includes(c.status),
        );
        const counts: Record<string, number> = {};
        for (const c of norm) counts[c.status] = (counts[c.status] || 0) + 1;
        const summary = Object.entries(counts)
          .map(([k, v]) => `${v} ${k.toLowerCase()}`)
          .join(", ");
        out.push(`\n## Checks (${summary})`);
        if (bad.length) {
          for (const c of bad) out.push(`- ⚠️ ${c.name}: ${c.status}`);
        } else {
          out.push(`- all ${passing.length} passing/skipped`);
        }
      }

      // Changed files.
      if (m.files?.length) {
        out.push(`\n## Files`);
        for (const f of m.files) {
          out.push(
            `- \`${f.path}\` +${f.additions}/−${f.deletions} (${f.changeType.toLowerCase()})`,
          );
        }
      }

      // Comments + review threads from GraphQL.
      let nComments = 0;
      let nThreads = 0;
      if (gql.code === 0 && gql.stdout) {
        try {
          const data = JSON.parse(gql.stdout) as {
            data: {
              repository: {
                pullRequest: {
                  comments: { totalCount: number; nodes: IssueComment[] };
                  reviewThreads: { totalCount: number; nodes: Thread[] };
                };
              };
            };
          };
          const pr = data.data.repository.pullRequest;

          const comments = pr.comments.nodes.filter(
            (c) =>
              a.includeBots ||
              !isBot(c.author?.login ?? "", c.author?.__typename),
          );
          nComments = comments.length;
          if (comments.length) {
            out.push(`\n## Comments`);
            for (const c of comments) {
              out.push(`**@${c.author?.login ?? "?"}**: ${c.body.trim()}`);
            }
          }
          const unfetchedC = pr.comments.totalCount - pr.comments.nodes.length;
          if (unfetchedC > 0)
            out.push(`\n_(+${unfetchedC} earlier comment(s) not fetched)_`);

          // Bots are NOT filtered out of review threads: inline findings
          // (CodeRabbit etc.) are line-anchored and actionable, unlike their
          // summary issue comments above.
          const threads = pr.reviewThreads.nodes.filter(
            (t) => a.includeResolved || (!t.isResolved && !t.isOutdated),
          );
          nThreads = threads.length;
          if (threads.length) {
            out.push(`\n## Review comments (unresolved)`);
            for (const t of threads) {
              const loc = `\`${t.path}\`${t.line ? `:${t.line}` : ""}`;
              const flags =
                (t.isResolved ? " [resolved]" : "") +
                (t.isOutdated ? " [outdated]" : "");
              out.push(`\n${loc}${flags}`);
              for (const c of t.comments.nodes) {
                out.push(
                  `- **@${c.author?.login ?? "?"}**: ${stripHtmlComments(c.body)}`,
                );
              }
            }
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
      } else if (gql.stderr && !gql.stderr.includes("skipped")) {
        out.push(
          `\n_(comments unavailable: ${gql.stderr.trim().split("\n")[0]})_`,
        );
      }

      // Diff last — biggest, most useful for code review.
      if (wantDiff && diff.code === 0 && diff.stdout) {
        let d = diff.stdout;
        let note = "";
        if (Buffer.byteLength(d) > MAX_DIFF_BYTES) {
          d = d.slice(0, MAX_DIFF_BYTES);
          note = `\n…[diff truncated at ${fmt(MAX_DIFF_BYTES)} bytes — read files for full context]`;
        }
        out.push(`\n## Diff\n\`\`\`diff\n${d}\n\`\`\`${note}`);
      }

      const parts = [
        m.state.toLowerCase(),
        `${m.changedFiles} files`,
        nThreads ? `${nThreads} review comment(s)` : null,
        nComments ? `${nComments} comment(s)` : null,
      ].filter(Boolean);
      const summary = `PR #${m.number} · ${parts.join(" · ")}`;
      return {
        content: [{ type: "text" as const, text: out.join("\n") }],
        details: { summary },
      };
    },
  });
}
