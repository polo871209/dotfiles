---
name: writing-agent-instructions
description: Read before writing or editing any agent-facing instructions — an agent skill (SKILL.md and whatever it links to), a tool/function description, or an extension's injected context. Covers discoverability, information hierarchy, and token-lean design.
disable-model-invocation: true
---

A skill, tool description, or extension prompt exists to wrangle **predictability** out of a stochastic system — the agent taking the same _process_ every run, not necessarily producing the same output (a brainstorming skill should predictably diverge; its tokens vary, its behavior doesn't). Every rule below is a lever on that, not an end in itself.

A skill is a directory with a `SKILL.md` file. Everything else is freeform — no required folder names, no required nesting. A file only gets read if something already loaded points at it with a working relative path; a folder named `references/` that nothing links to is dead weight, and a link named anything else that fires reliably is fine. Structure is a convention for your own scanability, not a schema the loader enforces.

## Invocation

Two ways a skill gets reached, trading different costs:

- **Model-invoked** keeps a `description` in frontmatter, so the agent fires it on its own — and the human can still type its name, so this always includes user reach too. Costs **context load**: the description sits in the window every turn, forever, whether or not it's used. Pick this only when the agent must find the skill unprompted, or another skill needs to reach it.
- **User-invoked** (`disable-model-invocation: true`) strips the description from the agent's reach. Only a human typing the skill's name can fire it, and no other skill can either. Zero context load, but it spends **cognitive load** instead — the human is now the index that must remember the skill exists and when to use it.

When user-invoked skills pile up past what's memorable, don't promote them to model-invoked to compensate — write one **router skill**: a single user-invoked skill that just names the others and when to reach for each. One thing to remember instead of many.

## Writing the description

The description does two jobs: state what the skill is, and list the branches that should trigger it. Every word in it is paid on every turn, so it earns harder pruning than the body:

- Front-load the leading word (see below) the description does its triggering work on — the distinguishing concept first, not buried in a subordinate clause.
- One trigger per distinct branch. Restating the same case in synonyms ("use for X, or Y-like things") is duplication dressed as coverage — collapse it.
- Cut identity that's already obvious from the body; keep the description to triggers plus any "another skill needs this" reach clause.
- Include explicit negative triggers — what it's _not_ for — cheap and prevents mis-fires.

Mechanical rules: `name` is 1–64 chars, lowercase + digits + hyphens, no leading/trailing/consecutive hyphens, prefer a gerund (`processing-pdfs`). `description` ≤1024 chars, third person. Avoid vague names (`helper`, `utils`) and vendor-locked ones.

## Information hierarchy

Rank content by how immediately the agent needs it, then push everything you can down the ladder:

1. **Steps** — ordered actions written directly in `SKILL.md`. The primary tier, when a skill has them at all (a flat rule set with no ordering, like a review checklist, is a legitimate shape too — not every skill needs steps).
2. **In-file reference** — definitions/rules/facts kept in `SKILL.md`, consulted on demand rather than executed in order.
3. **Disclosed reference** — pushed to a separate linked file, loaded only when the link fires.

Every step should end on a **completion criterion**: the condition that tells the agent it's actually done. Make it checkable ("tests pass" beats "code looks good") and, where correctness demands it, exhaustive ("every modified caller updated" beats "update callers"). A vague criterion invites the agent to call it done before it is — the root cause of **premature completion**.

Branching decides what to disclose: if a skill has several distinct cases it can run through, inline whatever _every_ branch needs, and push behind a link whatever only _some_ branches reach. If a link that should fire reliably isn't getting followed, sharpen its wording first ("for auth errors see `references/auth.md`" beats "see also") — pull the content back inline only if that fails.

**Co-locate**: keep a concept's definition, rules, and caveats under one heading, not scattered across the file, so reading one part brings its neighbours with it.

## Leading words

A **leading word** is a compact concept already living in the model's pretraining — _tracer bullet_, _fog of war_, _tight loop_ — that the agent thinks with instead of a spelled-out sentence. Repeat the word, not a restated definition of it, and it accumulates meaning across the skill for free, anchoring two things at once: in the body it points execution at the same behavior every time it appears; in the description, if the same word also lives in your prompts and code, the agent links that shared vocabulary to the skill and fires it more reliably.

Hunt for triads spelled out in full ("fast, deterministic, low-overhead" → _tight_) or a description spending a clause to gesture at one idea. Prefer an existing pretrained word over coining one — a made-up term recruits no priors, so you pay in definition tokens what a real word gives free.

## When to split

Splitting spends a load from Invocation above — a new model-invoked skill spends context load, a new user-invoked one spends cognitive load — so only split when the cut earns it. Two legitimate cuts:

- **By invocation** — pull out a separate skill when there's a distinct leading word that should trigger it independently, or another skill needs to reach it directly.
- **By sequence** — cut a run of steps in two when the steps still ahead are causing premature completion on the one in front of them; isolating the tail (a real hand-off, not just a heading break) clears it from view. Merging skills back together reverses this — it re-exposes every step's later steps to whatever now follows.

## Pruning

Every fact or rule should live in exactly one place — its **single source of truth**. The same meaning stated twice costs upkeep (two places to update) and inflates that meaning's importance past what it earns.

Before writing any line, run the **no-op test**: does this change the agent's behavior versus what it would already do by default? If not, delete it, even if it's true. A weak instruction that fails the test ("be thorough") isn't fixed by rewording softly — either sharpen it into something that actually binds ("account for every modified caller"), or cut it. Cut on sight: explanations of standard library/CLI behavior, restating what a well-named script obviously does, time-stamped claims ("as of 2025...").

One exception: inferable is not sufficient to delete. Before cutting a line that looks redundant, check why it's there — many exist because a model actually failed that way once, and the line is scar tissue preventing a repeat. Keep scar tissue even when something else could technically teach the same thing.

## Failure modes

Names for diagnosing a skill that isn't landing, each paired with its cure:

- **No-op** — a line that changes nothing because the model does it by default. Cure: delete, or replace with a leading word strong enough to actually bind.
- **Duplication** — one meaning stated in more than one place. Cure: single source of truth — pick one home, delete the rest.
- **Sediment** — stale content that piled up because adding felt safe and removing felt risky. Cure: an actual pruning pass, not more additions.
- **Sprawl** — the skill is simply too long, even with zero duplication or staleness. Cure: push reference down the information hierarchy and split by branch or sequence so each path only carries what it needs.
- **Premature completion** — ending a step before it's genuinely done because attention slipped to _being done_ rather than the work. Fix cheapest-first: sharpen the completion criterion; only split off the later steps if the criterion is irreducibly fuzzy _and_ you've actually observed the rush.

## Writing for the agent, not the human

Third-person imperative ("Extract the field...") not first/second person. Numbered steps with explicit decision branches ("if X, do A; else do B") over prose that hides the branch in a sentence. Pick one term per concept and never swap it for a synonym mid-skill. No README/CHANGELOG/install-guide framing — skills aren't human docs, and none of that survives the no-op test for an agent reader anyway.

Match instruction strictness to task fragility: prose heuristics where many approaches are valid, a parameterized script where one pattern is preferred, an exact script with fixed args where the task is fragile and must be deterministic. A migration script wants the last; a code review wants the first.

## Tool and extension descriptions

Everything above applies just as much to a tool's `name`/`description`/parameter schema and to text an extension injects every turn — both are read the same way a skill is, and both are paid for on every turn they're in context, so prune them harder if anything.

A tool description teaches the agent _when to reach for it and what shape its input takes_ — never how it works inside. If the agent's behavior wouldn't change on learning a mechanism detail (caching, retry, internal file names), it doesn't belong in the prompt. Order: one-line purpose in the agent's vocabulary, the input grammar/params it will actually emit, worked examples covering the common shapes, failure shapes the agent itself can fix by changing input, WRONG/RIGHT anti-pattern pairs drawn from real failures, and — if the tool is complex — a short recap of the load-bearing rules for when the agent skims.

Prune against the schema, not by guessing: whatever the JSON parameter schema and tool name already teach (names, types, required-ness) is a prune candidate in the prose, since the schema gets read too. What the schema can't teach — default directions, cross-tool routing, exact output shape, domain grammar invisible to a type — is load-bearing and stays.

For anything an agent reads back as output — script stdout, a tool result, injected context — minimize tokens and round-trips: compact/tabular over JSON, a minimal default field set with a flag to ask for more, truncate-with-a-preview instead of omitting, inline aggregates ("30 of 847") so the agent skips a follow-up call, explicit empty states ("0 found") instead of blank, and idempotent mutations where desired-state-already-true reads as success, not error.

## Portability

Don't assume a specific agent runtime: describe actions generically ("run the script", "read the file"), not by a host's tool name. Don't rely on vendor-specific context-window tricks. If a skill only works with one model family, say so in the description.

## Validation

Two cheap checks with a fresh model before shipping. Discovery: paste only the frontmatter and ask it to generate 3 prompts that should trigger the skill and 3 lookalikes that shouldn't — critique the description on the misses. Logic: paste the full `SKILL.md` and simulate a run against a sample request, walking each step and flagging anywhere it would be forced to guess.

Then build a few real evals, baseline without the skill, and iterate until the baseline is beaten — a skill that reads well but never measurably changes outcomes hasn't earned its context load.
