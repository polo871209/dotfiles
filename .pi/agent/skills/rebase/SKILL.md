---
name: rebase
description: Rebase the current branch onto a target and resolve conflicts non-interactively.
disable-model-invocation: true
---

Rebase the current branch onto the target the user names. If the user names none, use the **base ref**: `origin/$(gh pr view --json baseRefName -q .baseRefName)`, or `origin/HEAD` when the branch has no PR. Run `git fetch origin` first, and use the `origin/` tip of a named branch.

If the worktree has uncommitted changes, stop and report, because they can belong to other agents in this tree.

Prefix every `git rebase` command with `GIT_EDITOR=true`. A bare `git rebase --continue` opens an editor and waits forever.

## Resolve conflicts

- In a rebase, `--ours` is the target and `--theirs` is the commit being replayed.
- Read why each side changed the hunk, then write a result that keeps both intents.
- For a lockfile or generated file, take `--ours` and regenerate it with the project's tool.
- If a conflict needs a product decision, ask the user, giving the hunk and one option per side, then resolve it with the answer.

After you resolve conflicts, run the project's checks, because a clean text merge can still break the build.

Done when no rebase is in progress and you reported the outcome.
