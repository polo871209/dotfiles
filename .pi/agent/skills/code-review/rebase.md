# Rebase conflict resolution

A rebase onto the fixed point is mid-flight with conflicts. Resolve it in this session, under these rules:

- **Keep the intent of BOTH branches**: merge semantics, never blindly pick ours/theirs.
- **Non-interactive git ONLY: #1 failure mode.** Bare `git rebase --continue` opens an editor and HANGS forever. Always `GIT_EDITOR=true git rebase --continue` (and `GIT_SEQUENCE_EDITOR=true` for interactive rebases).
- If a conflict needs a product decision, `git rebase --abort` and report which files/hunks and why.
- Done when: `git status` clean, no rebase in progress.

Before reviewing, verify no rebase in progress. If the rebase aborted, report to the user and stop. Don't review a stale base.
