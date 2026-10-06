---
name: cleanup
description: Remove dead code and comments from a scope, then fix the code the comments excused.
disable-model-invocation: true
---

Cleanup runs two passes over one scope. The dead-code pass deletes only code proven unused. The comment pass hands comments to the `comment-sicko` subagent, which deletes every comment outside the keep list and flags code with `MUST KILL`. This skill then audits that work and fixes the flagged code. Trust comment-sicko's fresh eyes. Overrule it only for the rejections in step 4.

The keep list is the `Comments` section of the system prompt. Audit comments against that section and nothing else.

## 1. Pin scope

Build the allowed file set from these modes:

- **Session mode** by default: files edited by the agent during this session.
- **Named mode** when the user supplies files, directories, or globs: every matching file, whether clean or dirty.
- **Branch mode** when the user asks for the branch: the diff against the base branch, `main` by default, plus uncommitted and untracked files.
- **Dirty-worktree mode** only when the user explicitly requests whole-worktree cleanup: every modified or untracked file in the current worktree.

Combine explicitly requested modes. Explicit exclusions win. Git-dirty status alone does not grant permission outside dirty-worktree mode.

Session mode requires reliable session-edit provenance. Clean only lines this session added or made obsolete, and preserve pre-existing user changes. If provenance is unavailable, skip the file unless the user authorizes it through another mode.

Exclude generated files, vendored code, lockfiles, snapshots, and minified assets. Override this exclusion only when the user names the exact file or explicitly requests that artifact class.

If the allowed set is empty, stop and report that nothing qualifies.

Completion: every file in scope has a mode that admits it, and in session mode every file has its line ranges.

## 2. Remove dead code

Capture the current state of the scope before editing. Inspect diffs for tracked dirty files and the full contents of clean or untracked files.

Prefer deterministic evidence from diagnostics, compiler or linter output, LSP references, repository search, package entrypoints, and manifests. Before deleting a symbol, account for static references and plausible dynamic use such as reflection, registration, serialization, configuration keys, string lookup, or framework conventions. Treat exported symbols as public until entrypoints and package boundaries prove otherwise. If absence of use cannot be proven, leave the candidate and report it.

Delete when proven unused or unreachable:

- Imports, locals, constants, private functions, classes, exports, or types.
- Statements after unconditional control transfer, and branches whose condition is provably constant.
- Variables assigned but never read.
- `try/catch` blocks that only rethrow the same error unchanged.
- Defensive checks made impossible by an enforced type or invariant.

Do not delete compatibility hooks, public API, registrations, schema fields, serialization fields, or extension points based only on text search.

Touch only candidate lines. Do not reformat, rename, reorder, simplify live logic, or refactor adjacent code. Match existing style.

Completion: every deletion has evidence that it is unreachable, unreferenced, or redundant, and this step's diff holds only deletions.

## 3. Spawn comment-sicko

1. Copy every scope file to a snapshot directory under `$TMPDIR`. Other agents edit this tree, so step 4 diffs against the snapshot to isolate comment-sicko's edits.
2. Call the `subagent` tool with agent `comment-sicko` in the foreground. Pass the file list, the diff command, or in session mode the line ranges. Do not restate its rules.

If the `subagent` tool is missing, skip steps 3 to 6 and report that the comment pass did not run. The tool needs tmux and does not exist inside a subagent.

Completion: a report with touched files, deletion count, `MUST KILL` flags, keeps, and skips.

## 4. Audit the comment pass

Diff each scope file against its snapshot. Rule on every deletion, keep, and flag:

- **Edit outside the rules.** If comment-sicko changed application code or touched lines outside the scope, restore the snapshot and rerun step 3 once with the failure named in the task. If the rerun fails the same way, restore the snapshot, report the failure, and skip to step 7.
- **Deletion.** Restore a deleted comment only if it meets an exact keep exception and you can prove it from code in scope. If a kill is ambiguous, leave it deleted. Never restore a comment about a surprise in our own code. Its `MUST KILL` flag carries the fix.
- **Keep.** A keep survives only with proof that it is about something we cannot change. If the proof is refuted or still ambiguous, delete the comment.
- **Flag.** Reject a `MUST KILL` whose reason misstates the code, or that calls intentional code guilty when that code stays.
- **Thin claim.** Before you accept a kill or keep that rests on `IMPORTANT` or `do not remove`, read the callers, run `git log -L` on the lines, and open the linked issue.

Then search the scope for lint and type suppressions that comment-sicko missed. If a suppression hides a rule that protects correctness or safety, delete it and add a `MUST KILL` flag.

Completion: every deletion, keep, and flag is accepted or rejected, and the scope differs from the snapshot only by accepted deletions.

## 5. Fix accepted flags

This step is the only one that changes live logic.

1. Fix trivial flags directly: delete the dead path, drop the parameter, or call the real API.
2. If any fix needs a new shape, write one sketch in chat for all of them before you edit. Name the files, the symbols, and the new shape.
3. Implement the smallest root-cause fix inside the scope. Remove every workaround that a deleted comment named. Never add a guard that only hides the symptom.
4. If the root cause is outside the scope, fix the part inside the scope and report the rest open. Never widen the scope.

Completion: every accepted flag is fixed or reported open with its reason.

## 6. Encode claimed constraints

A claimed constraint is a deleted comment that says `do not remove`, `do not change wording`, `talk to X before changing`, or similar.

1. For each one, first look for a code change inside the scope that removes the constraint. If one exists, make it and skip the offer. Otherwise, offer the cheapest encoding inside the scope: a type, a runtime check, a test, or a lint rule.
2. Ask the user and wait. If no user can answer, treat the offer as declined unless the caller approved encodings in advance.
3. If approved, implement the encoding.
4. If declined, leave the comment deleted, report the constraint as unenforced, and sketch the work outside the scope that enforces it.

Completion: every claimed constraint is encoded or reported unenforced.

## 7. Verify and report

Run the project's type check, lint for the touched files. If they fail, fix the cause and run them again.

Report the dead-code deletions, skipped candidates, comment deletion count, restored comments, reruns, the sketch, fixes, encodings, unenforced constraints, and other open work.

Completion: the checks pass, or the report names each failure that remains and its cause.
