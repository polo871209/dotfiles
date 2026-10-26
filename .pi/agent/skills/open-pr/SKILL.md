---
name: open-pr
description: Push the current branch and open a ready GitHub PR with a Conventional Commits title and a short briefing body.
disable-model-invocation: true
---

Open a PR for the current branch with `gh`. If a PR already exists for the branch, update its title and body instead of creating a second one.

## Title

Use Conventional Commits `type(scope): subject`, with no trailing period.

- Type is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`.
- Scope is the area the change touches, such as a package, tool, or directory name.
- Subject is short and imperative. If one symbol carries the change, name it, for example `fix(nvim): drop stale lsp keymap`.

## Body

A reviewer who already has the diff must read the body in under 2 minutes, with or without a template. Keep it high level. Explain what the PR is for and what it changes for users or the system, and leave the implementation to the diff.

If the repository has a pull request template, fill it in and drop sections that do not apply. Look for `pull_request_template.md` in any case under `.github/`, the root, or `docs/`, and for a `PULL_REQUEST_TEMPLATE/` directory.

Without a template, use these sections:

- `## Why`: the problem this PR solves, in 1 or 2 sentences.
- `## Scope`: what the PR covers and what it leaves out, in 1 to 3 items.
- `## Verification`: each check you ran and its outcome.

Add a line on risk only when a reviewer needs it.

If the change spans many files or components, add a Mermaid diagram of how the changed components connect. GitHub renders a fenced `mermaid` block as a graph.

## Create the PR

Write the body to a temporary file and run `gh pr create --title "<title>" --body-file <file>`. Open the PR ready for review, so leave out `--draft`.

Done when `gh pr view --json url,isDraft,title` shows the PR as not draft with the title you wrote. Reply with the PR URL.

## Stack

If the user asks for a stack, use `gh stack` instead of `gh pr create`. Each layer is one branch and one PR, ordered bottom to top.

1. If no stack exists, run `gh stack init <first-branch>`. To adopt branches that already exist, list them bottom to top.
2. For each later layer, stage only that layer's files and run `gh stack add -m "<commit message>" <branch>`. This command creates the branch on top of the stack and commits the staged files.
3. Run `gh stack submit --auto --open`. Without `--open`, `--auto` creates draft PRs.
4. `--auto` generates the titles, so set the title and body of each PR with `gh pr edit <branch> --title "<title>" --body-file <file>`.

Done when `gh stack view --json` lists a PR for every layer and `gh pr view <branch> --json isDraft` shows each one is not a draft. Reply with the PR URLs, bottom to top.
