---
name: code-review
description: Review the diff since a fixed point for bugs, standards, spec, and stale docs. Fixes stale docs in place.
disable-model-invocation: true
---

Review the diff between `HEAD` and a fixed point on separate axes. Each pass runs as a `reviewer` subagent (hidden: call `subagent` with `agent: "reviewer"`) with fresh context. The reviewer carries the rubric, the finding format, and the smell baseline in its own prompt. Pass only the brief for its axis.

- **Bugs** (always, two passes): is the code correct?
- **Standards** (always): does the code follow the repo's documented standards?
- **Docs** (always): did the diff make a doc or comment false? This skill fixes those in place.
- **Spec** (only when the user passes a spec): does the code implement it?

## 1. Pin the fixed point

The fixed point is what the user names: a SHA, branch, tag, or `HEAD~5`. If the user names none, use the **base ref** from `../rebase/SKILL.md`, after `git fetch origin`.

The diff command is `git diff <fixed-point>...HEAD`. Three dots compare against the merge-base, so only this branch's changes show. The commit list is `git log <fixed-point>..HEAD --oneline`.

Completion: `git rev-parse <fixed-point>` succeeds and the diff is non-empty. Otherwise stop and report.

## 2. Gather intent

Intent is what the author meant the change to do. Collect:

- The PR title and body with `gh pr view --json title,body`, if a PR exists.
- The full commit messages with `git log <fixed-point>..HEAD --format=%B`.
- The spec, only if the user passed one: a path, an issue number fetched with `gh issue view`, or a URL.

## 3. Find standards sources

List every file that documents how to write code in this repo. `CODING_STANDARDS.md`, `CONTRIBUTING.md`, and every `AGENTS.md` on the path of a changed file must be on the list when they exist.

## 4. Spawn the passes

Send every `subagent` call in one message, in the foreground. Every task gets the diff command, the commit list, the intent, one brief, and a 400-word cap:

- **Bugs, diff pass**: "Read only the diff. Flag bugs you can prove from the diff alone: wrong logic, broken types or imports, unhandled errors, security holes."
- **Bugs, context pass**: "Read the changed code with its context. Follow callers with `lsp` references and check history with `git log -S` for reverted fixes. Flag bugs in the changed code, including callers it breaks."
- **Standards**: the files from step 3. "Flag every place the diff breaks a documented rule. Add baseline smells."
- **Docs**: "Find every doc and comment the diff made false or incomplete: comments in and near changed hunks, and repo text (README, `docs/`, `AGENTS.md`, skills, doc comments, help text) that names a symbol, flag, path, configuration key, or behavior the diff changed, renamed, added, or removed. Quote the stale text. The trigger is the hunk that makes it false."
- **Spec**, if the user passed one: the spec path or contents. "Flag requirements that are missing or partial, behavior the spec did not ask for, and requirements implemented wrong."

## 5. Verify every finding

Subagent findings are often false. Treat each one as a claim and check it against the repository:

- The cited range exists and overlaps the diff. For Docs, the quoted text exists at the cited path.
- The code does what the finding says. Read around the hunk, because the guard a finding calls missing often lives outside it.
- For Bugs, the trigger is reachable from a real caller or input.
- A quoted rule or spec line exists and says what the finding claims.
- For a missing requirement, search the whole branch before you accept that it is absent.

Merge findings that name the same defect. Drop every unverified finding without a trace: no mention, no count. Keep only the verified part of a partly true finding, rewritten to match the code.

Completion: every finding is verified or dropped.

## 6. Fix stale docs

Fix every verified Docs finding without asking. Rewrite only the false words so the text matches the code, in the style and length around it. If the stale text is a comment outside the `Comments` keep list of the system prompt, delete it.

Completion: every verified Docs finding is fixed, and this step's edits touch only doc and comment lines.

## 7. Report

Name the fixed point. List the verified findings under `## Bugs`, `## Standards`, and `## Spec` when it ran, highest priority first within each axis. Keep the axes separate, because code can follow every rule and still implement the wrong thing. Under `## Docs fixed`, list each edited `path:line` with one line on what changed.

End with one line: `Patch is correct` when no Bugs finding is P0 or P1, else `Patch is incorrect`, then the finding count and the worst finding of each axis.
