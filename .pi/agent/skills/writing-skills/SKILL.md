---
name: writing-skills
description: Read before writing or editing any agent skill (SKILL.md or files in scripts/, references/, assets/), or any agent-facing tool or extension. Covers structure, discoverability, and token-lean output design.
---

# Writing Agent Skills

Concise rules for authoring skills usable by any LLM agent.

> "Skill" = a discoverable bundle of instructions + optional scripts/refs that an agent loads on demand.

---

## 0. Golden Rule — Don't Teach What the Model Knows

Every token competes with the user's request. Before writing any line, ask:

- Does the model already know this?
- Does this sentence justify its token cost?
- Can I cut it and lose nothing?

If yes → delete. Skills add **missing** context (domain, conventions, tools), not generic knowledge.

Cut:

- "A PDF is a portable document format..."
- "JSON uses key-value pairs..."
- Explanations of standard library/CLI behavior.
- Restating what a well-named script obviously does.

Keep: project-specific rules, non-obvious gotchas, exact commands, schemas, naming conventions, negative triggers.

---

## 1. Structure

```
skill-name/
├── SKILL.md       # required: frontmatter + instructions
├── scripts/       # deterministic CLIs (Python/Bash/Node)
├── references/    # schemas, cheatsheets, docs
└── assets/        # templates, static output files
```

Rules:

- `SKILL.md` is the brain. Keep lean.
- Subdirs **one level deep only** (`references/api.md`, not `references/v1/api.md`).
- Forward slashes always (`scripts/run.py`).

---

## 2. Frontmatter (discoverability)

Only `name` + `description` are pre-loaded into the agent. If they fail, the skill is invisible.

```yaml
---
name: processing-pdfs
description: Extracts text and tables from PDF files. Use when the user wants to parse, summarize, or convert PDFs. Do not use for Word, Excel, or image-only documents.
---
```

Rules:

- `name`: 1–64 chars, lowercase + digits + hyphens. Must match directory name. Prefer gerund (`processing-pdfs`, `analyzing-spreadsheets`).
- `description`: ≤1024 chars, third person, includes **what** + **when** + **negative triggers**.
- Avoid vague names (`helper`, `utils`, `tools`).
- Avoid vendor-locked names (don't hardcode model/vendor strings).

Description:

- Bad: "React skills."
- Good: "Creates React components styled with Tailwind. Use when modifying component UI or styles. Do not use for Vue, Svelte, or vanilla CSS."

---

## 3. Progressive Disclosure

Load info only when needed.

- SKILL.md: high-level workflow + pointers.
- Reference files: loaded on demand. Tell the agent **exactly when** to read them: _"For auth errors see `references/auth.md`."_
- For ref files >100 lines: include a table of contents at top (agents may only preview head).
- No nested links chain — keep refs **one hop from SKILL.md**.

---

## 4. Write for Agents, Not Humans

- Third-person imperative: _"Extract the field..."_ — not "I will" or "you should".
- Step-by-step numbered procedures with decision branches:
  > Step 2: if sourcemaps needed run `ng build --source-map`. Else skip to Step 3.
- Concrete templates in `assets/` beat prose descriptions.
- Consistent terminology: pick **one** term per concept (always "field", never mix with "box"/"control").
- No README, CHANGELOG, install guides. Skills are not human docs.
- Delete anything the model already does reliably.

---

## 5. Degrees of Freedom

Match instruction strictness to task fragility:

| Freedom | Form                              | Use when                       |
| ------- | --------------------------------- | ------------------------------ |
| High    | prose heuristics                  | many valid approaches          |
| Medium  | pseudocode / parameterized script | one preferred pattern          |
| Low     | exact script, fixed args          | fragile, must be deterministic |

Database migrations → low freedom. Code review → high freedom.

---

## 6. Scripts

Bundle deterministic scripts for repetitive/fragile ops.

- Solve, don't punt: handle errors inside the script with descriptive stderr so the agent self-corrects.
- No magic numbers — document every constant.
- State intent: "**Run** `validate.py`" vs "**Read** `validate.py` as reference".
- Don't assume packages installed — list deps in SKILL.md.
- Plan → validate → execute pattern for batch/destructive ops: write a plan file, validate with script, then apply.

### Output design (agent-facing scripts, tools, extensions)

Anything an agent reads as output — script stdout, a custom tool's result, an extension's injected context — must minimize tokens and round-trips. Token saving is the goal:

- **Compact format**: tabular/compact over JSON (~40% fewer tokens). Convert at the output boundary; keep internal logic on JSON.
- **Minimal default schema**: 3–4 fields per list row, not 10. Offer a flag/param to request more.
- **Truncate + hint**: never omit big text — show a preview, total size, and a `--full`-style escape hatch.
- **Inline aggregates**: totals (`30 of 847`) and cheap derived status, so the agent skips a follow-up call.
- **Definitive empty states**: explicit "0 X found", not blank.
- **Content first**: a no-arg invocation shows live data, not help text.
- **Next steps**: end list/mutation output with a few complete next-step commands (placeholders for runtime values); omit on self-contained output.
- **Idempotent mutations**: desired-state-already-true is success, not an error.
- **Channels & exit codes** (CLIs): stdout = data + structured errors with a fix command, stderr = progress/debug, exit 0 success/no-op, 1 error, 2 usage.

Tools & extensions specifically:

- A tool's `name` + `description` + param schema are its discoverability surface — apply the frontmatter rules (§2): terse, trigger-shaped, no redundant params.
- Don't register a tool/extension that duplicates a capability the agent already has.
- Context injected every turn costs tokens on every message — keep it minimal and directory-scoped.

---

## 7. Workflows & Feedback Loops

Complex tasks → explicit checklist the agent copies into its response and ticks off.

Quality-critical tasks → validation loop:

```
run validator → fix errors → re-run → repeat until clean
```

Validator can be a script or a reference doc (e.g. `STYLE_GUIDE.md`).

---

## 8. Anti-patterns

- Time-sensitive info ("as of 2025..."). Use an "old patterns" section if historical context needed.
- Offering multiple approaches when one suffices.
- Long library code inside `scripts/` — keep scripts tiny + single-purpose.

---

## 9. Cross-Agent Portability

Skills should not assume a specific agent runtime. To stay portable:

- Reference tools generically: "run the script", "read the file" — not "use the Bash tool".
- Don't rely on vendor-specific context-window tricks.
- If skill works only with one model family, say so explicitly in the description.

---

## 10. Validation

Before shipping, run two cheap checks with a fresh LLM:

**A. Discovery test** — paste only the frontmatter:

> Given this YAML, generate 3 prompts that SHOULD trigger this skill and 3 lookalike prompts that should NOT. Critique the description.

**B. Logic test** — paste full `SKILL.md` + tree:

> Simulate as an agent triggered by `<sample request>`. Walk each step. Flag any place you'd be forced to guess.

Then build ≥3 real evals, baseline without skill, iterate until baseline beaten.

**Drift guard**: if SKILL.md duplicates content the code/CLI already prints (e.g. generated from a home view), generate it instead of hand-copying, and add a CI `--check` step that fails on staleness.

Develop iteratively: use one agent instance to author, another fresh instance to consume. Observe where the consumer struggles; refine.
