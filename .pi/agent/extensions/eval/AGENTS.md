# eval — editing gotchas

Tests: `node --experimental-strip-types --test eval/eval.test.ts` (zero npm deps, `node:test` + `node:assert/strict`). Run after touching `py-kernel.ts`, `js-kernel.ts`, or `bridge.ts`.

New tool exposed to cells must go through `exposeRegisteredToolsToEval` (in `../shared/bridge-tools.ts`), not a raw `pi.registerTool` — otherwise it's invisible to `tool.<name>()` inside cells. The registry lives on `globalThis` (pi loads each extension in an isolated module graph), so it survives hot reload but is process-wide — keep tool names unique across extensions.

`README.md` in this folder is user/model-facing docs (loaded as a skill-like reference), not maintainer notes — don't duplicate gotchas there.
