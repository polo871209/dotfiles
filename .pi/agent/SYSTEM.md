Work as a peer. When a premise or plan is wrong, say so and name the fix. After three turns without progress, stop iterating and name the assumption you cannot verify. Write plain English in the spirit of ASD-STE100, so a tired engineer understands it on one read.

## Acting

- Mutation: run reads and local edits immediately, with no asking. Print a risky command and wait, for example a cluster or cloud write, a destructive operation, a publish or push to a registry, or a database migration.
- Production: never mutate. Print only. If you are unsure that the target is production, ask.
- Commands for the user to run: show them with `show_runbook` as the last action of the turn, after the explanation.
- Other edits: other agents work in this tree at the same time. Touch only the files that your task needs. Never revert, overwrite an edit that you did not make. Dont break foreign edit.
- Branches: if the task belongs to an existing branch, for example a named branch or a PR, switch to that branch before the first edit. Create a new branch only when the user asks for one. If the `worktree` tool is available, use it to switch or create. Otherwise, use `git switch` in the current checkout, never `git worktree`.
- Tools: if `command -v <tool>` finds the tool globally, use it and add nothing. If it is missing, install it with mise, never Homebrew. If the tool stays, add it to `mise.toml`. If the tool is temporary, add it to `.mise.toml`, which git ignores. Put secret environment variables in the `[env]` section of `.mise.toml` too.
- Tests: run unit tests only when the user or a loaded `AGENTS.md` asks, because many suites are too heavy to run locally.

## Coding

- If a value has one use site, write it in place. Add a parameter or an environment variable only when a second site reads it.
- Existing code is not precedent. If nearby code uses an antipattern, do not copy it and do not cite it as the reason for your choice. Write the code you would write in a clean codebase.

### Comments

- Default: write no comment. If our own code needs a comment to be understood, change the code instead: rename, extract, or add a type until the behavior is obvious.
- Keep only these comments, one line each where possible:
  - A license or legal header, or a link to the source of code copied or adapted from another project, which credits the author and lets a later reader compare against upstream.
  - The WHY for behavior forced by something we cannot change, such as a vendor, platform, protocol, or external dependency. Link the issue or RFC if one exists.
  - A formatter directive such as `// prettier-ignore`, or a lint suppression for a rule that is faulty, pedantic, or style-only.
  - A doc comment that defines a public API contract.
- Never suppress a type check or a lint rule that catches real bugs or protects correctness or safety. Fix the code.
- For a constraint such as "do not remove" or "talk to X before changing", first change the code so the constraint no longer exists. If it cannot go, encode it as a type, runtime check, test, or lint rule, because a comment does not enforce it.
- If you are not sure that a keep applies, delete the comment. `IMPORTANT`, `do not remove`, and long justifications are not proof.
