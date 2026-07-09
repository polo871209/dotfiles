---
name: code-review
description: Standards review of the diff since a fixed point; Spec axis added only when a spec exists.
disable-model-invocation: true
---

Two-axis review of the diff between `HEAD` and a fixed point (default branch unless the user says otherwise):

- **Standards** (always) — does the code conform to this repo's documented coding standards?
- **Spec** (only when a spec exists) — does the code faithfully implement the originating issue / PRD / spec?

Each axis runs as a **`reviewer` sub-agent** (read-only, hidden — invoke via the `subagent` tool with `agent: "reviewer"`) so they don't pollute each other's context (in parallel when both run), then this skill aggregates the findings. The reviewer carries the Fowler smell baseline in its own system prompt — don't paste it.

## Process

### 1. Rebase onto the default branch, then pin the fixed point

First rebase the branch onto the default branch's tip. Skip when the branch is the default branch or already up to date. On conflict, follow `./rebase.md`.

Then pin the fixed point. Whatever the user said is the fixed point — a commit SHA, branch name, tag, `HEAD~5`, etc. If they didn't specify one, default to the default branch.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.

### 2. Identify the spec source (optional)

Most work here starts without a formal spec — that's the normal case, not a failure. Look for one, in this order:

1. A path the user passed as an argument.
2. Issue/PR references in the commit messages (`#123`, `Closes #45`, etc.) — fetch via `github_pr` or `gh issue view`.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.

If nothing turns up, skip the Spec axis silently — do NOT ask the user for one — and note "no spec; Standards only" in the final report.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md`, `CONTRIBUTING.md`, or `AGENTS.md`.

(The fixed Fowler smell baseline lives in the reviewer agent's system prompt, not here.)

### 4. Spawn both sub-agents in parallel

Standards always runs; Spec only when step 2 found a spec — then send both `subagent` calls in a single message.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

### 5. Aggregate

Present each report that ran under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why two axes (when both run)

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
