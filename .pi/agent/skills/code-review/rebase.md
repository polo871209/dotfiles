# Rebase conflict resolution

A rebase onto the default branch is mid-flight with conflicts. Do NOT resolve in the main session — spawn a `worker` sub-agent via the `subagent` tool with a task carrying the repo path and these rules:

- **Keep the intent of BOTH branches** — merge semantics, never blindly pick ours/theirs.
- **Non-interactive git ONLY — #1 failure mode.** Bare `git rebase --continue` opens an editor and HANGS forever. Always `GIT_EDITOR=true git rebase --continue` (and `GIT_SEQUENCE_EDITOR=true` for interactive rebases).
- If a conflict needs a product decision, `git rebase --abort` and report which files/hunks and why.
- Done when: `git status` clean, no rebase in progress.

After the worker returns, verify no rebase in progress. If it aborted, report to the user and stop — don't review a stale base.
