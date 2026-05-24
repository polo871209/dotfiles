---
description: Strip dead code and useless comments per house rules
---

Clean up dead code and comments. **Scope: files you edited in THIS session OR files dirty in `git status --porcelain`** (union of the two). Do NOT touch any file outside that set, even if you spot issues there. If the set is empty, stop and say so.

Rules:

**Comments — delete if any apply:**

- Decorative dividers (`# ====`, `# ----`, banners, boxes).
- Restates what the next line obviously does ("increment i", "loop over items").
- History notes ("Replaces…", "Legacy…", "Previously…", "Was X, now Y"). Keep current state only.
- Commented-out code with no TODO/explanation.
- Stale: contradicts the code below it.

**Comments — keep / rewrite:**

- WHY, not WHAT. Non-obvious intent, tradeoff, gotcha, link to issue.
- Shorten verbose explanations to one line where possible.

**Dead code — delete:**

- Unreferenced functions, classes, exports, constants, imports, types.
- Unreachable branches (always-false guards, post-`return` statements).
- Vars assigned but never read.
- `try/catch` that only re-throws unchanged.
- Defensive checks for impossible scenarios.

**Hard rules:**

- Surgical. Touch only dead/comment lines. No reformatting, no renames, no "while I'm here" refactors.
- Use LSP references (`lsp_references`) before deleting any exported symbol. If used outside scope, leave and report.
- Public API (exported from package entry) — do NOT delete without confirming. List candidates instead.
- Match existing style.
- After edits, report: files touched, lines removed, anything you flagged-but-skipped.
