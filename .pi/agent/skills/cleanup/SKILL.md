---
name: cleanup
description: Remove proven dead code and low-value comments from files edited this session.
disable-model-invocation: true
---

Remove only code and comments proven not to affect behavior. Skip uncertain candidates instead of guessing.

## 1. Pin scope

Build the allowed file set from these modes:

- **Session mode** by default: files edited by the agent during this session.
- **Named mode** when the user supplies files, directories, or globs: every matching file, whether clean or dirty.
- **Dirty-worktree mode** only when the user explicitly requests whole-worktree cleanup: every modified or untracked file in the current worktree.

Combine explicitly requested named and dirty-worktree scopes; explicit exclusions win. Git-dirty status alone does not grant permission outside dirty-worktree mode.

Session mode requires reliable session-edit provenance. Preserve pre-existing user changes and clean only material introduced or made obsolete by this session. If provenance is unavailable, skip the file unless the user authorizes it through named or dirty-worktree mode.

Exclude generated files, vendored code, lockfiles, snapshots, and minified assets. Override this exclusion only when the user names the exact file or explicitly requests that artifact class.

If the allowed set is empty, stop and report that nothing qualifies.

Completion: every candidate belongs to the allowed set and has a clear reason for becoming cleanup work.

## 2. Find and prove candidates

Capture the allowed files' current state before editing. Inspect diffs for tracked dirty files and the full contents of clean or untracked files. Preserve every baseline change that is not a proven cleanup candidate.

Prefer deterministic evidence from diagnostics, compiler or linter output, LSP references, repository search, package entrypoints, and manifests.

Before deleting a symbol, account for static references and plausible dynamic use such as reflection, registration, serialization, configuration keys, string lookup, or framework conventions. Treat exported symbols as public until entrypoints and package boundaries prove otherwise.

If absence of use cannot be proven, leave the candidate and report it.

Completion: every proposed deletion has evidence that it is unreachable, unreferenced, redundant, or comment-only, and every pre-existing non-candidate change is accounted for.

## Comment rules

A comment's primary reader today is an agent, not a human, so judge every comment as agent-facing prose: invoke the `writing-for-agents` skill before ruling on any of them. Two of its rules decide most cases — the **no-op test** (a comment that changes no reader's behavior is dead weight, even when true) and the **scar tissue** exception (a comment that reads as redundant often exists because a model already failed that way once, so inferable is not sufficient to delete).

Delete a comment when any condition applies:

- Decorative divider, banner, box, or visual filler.
- Restates the next line or narrates obvious control flow.
- Records history instead of current intent.
- Comments out code without a concrete TODO or explanation.
- Contradicts the code it describes.

Keep or shorten comments that carry:

- Non-obvious intent, trade-off, invariant, gotcha, or issue link.
- Public API documentation.
- License or copyright text.
- Generated-file markers, formatter controls, linter directives, type suppressions, or other tool instructions.
- A concrete TODO that still applies.
- Scar tissue: a caveat that reads as obvious but plausibly exists because someone already got it wrong.

Rewrite only to preserve the same meaning more concisely.

## Dead-code rules

Delete when proven unused or unreachable:

- Imports, locals, constants, private functions, classes, exports, or types.
- Statements after unconditional control transfer.
- Branches whose condition is provably constant.
- Variables assigned but never read.
- `try/catch` blocks that only rethrow the same error unchanged.
- Defensive checks made impossible by an enforced type or invariant.

Do not delete compatibility hooks, public API, registrations, schema fields, serialization fields, or extension points based only on text search.

## 3. Apply surgical edits

Touch only candidate lines. Do not reformat, rename, reorder, simplify live logic, or perform adjacent refactors. Match existing style.

Completion: the cleanup diff contains only deletions and meaning-preserving comment rewrites justified by the rules above.
