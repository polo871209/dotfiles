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

A reviewer who already has the diff must read the body in under 2 minutes, with or without a template. Cover only the main points a reviewer needs. Keep a detail only if it changes the reviewer's decision or the deploy.

Summarize by area, in prose and bullets. Leave per-file, per-route, and per-caller lists, tables, wrapper names, counts, and rename lists to the diff.

If the repository has a pull request template, fill it in and drop sections that do not apply. Look for `pull_request_template.md` in any case under `.github/`, the root, or `docs/`, and for a `PULL_REQUEST_TEMPLATE/` directory. Deploy sections, such as "Kubernetes to deploy", "deploy after", and "Cronjob to deploy", are the deploy contract. Fill them in full, with every item, and keep the template's wording.

Use these sections, or map them onto the template:

- `## Why`: 2 or 3 sentences. Say what the system did before, what this PR changes, and the one mechanism behind it. If the PR is a follow-up, link the earlier PR.
- `## Scope`: one bullet per area, 5 at most. Start each bullet with a plain label, such as `Callers:` or `Rules:`, followed by 1 or 2 sentences. Group exceptions by reason, for example "Calls that name an acting user", in about 4 bullets. If a call behaves differently, for example it loses a token, give it one sentence with the reason it still works.
- `## Risks`: only what can break in production, 3 bullets at most, each with the action to take or avoid, for example "Do not redeploy X". Drop the section when nothing applies.
- `## Verification`: each check you ran and its outcome, plus one line on what the tests prove. Leave out test internals and flaky-test notes.

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
