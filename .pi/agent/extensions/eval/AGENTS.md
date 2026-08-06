# eval — reference & editing gotchas

Registers the `eval` tool: persistent Python (`python3 -u`, managed venv) and JavaScript (`node:vm`) kernels, state surviving across cells and across `eval` calls within a session. Cells reach pi's own tools via `tool.<name>(args)` over a loopback HTTP bridge.

## Test

After changing `py-kernel.ts`, `js-kernel.ts`, or `bridge.ts`, run from `.pi/agent/extensions/`:

```sh
node --experimental-strip-types --test eval/eval.test.ts
```

Completion: command exits 0 with no failing tests.

## Architecture

```
pi process (Node)                          python3 subprocess (~/.cache/pi-eval/venv)
  index.ts     registers tool, wires          runner.py    stdin JSON loop, execs into
               kernels + bridge                            globals_dict, emits events on fd 3
  bridge.ts    node:http on 127.0.0.1:RANDOM   prelude.py   defines tool proxy, read/write/
  py-kernel.ts manages the python3 subprocess               tree/display/install at boot
  js-kernel.ts runs cells in node:vm
```

Three channels: **stdin** (Node→Python, one JSON request/line), **fd 3** (Python→Node, `stream`/`display`/`done` events), **loopback HTTP** (Python→Node, `tool.<name>(args)` calls — separate channel, bearer-token gated). JS kernel runs in-process but shares the same HTTP bridge for `tool.*`.

## Files

| File           | Role                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `index.ts`     | Tool registration, per-session kernel + bridge lifecycle, routes cells by language.             |
| `bridge.ts`    | Shared `node:http` server, one per session id, bearer-token gated, `server.unref()`.            |
| `py-kernel.ts` | Spawns/manages the python3 subprocess, timeout escalation, reset, `alive` for recycling.        |
| `runner.py`    | Long-lived exec loop; captures last-expression value via AST; emits fd 3 events.                |
| `prelude.py`   | `tool` proxy (urllib) + `display`/`read`/`write`/`tree`/`install`, exec'd at boot.              |
| `js-kernel.ts` | `node:vm` context; top-level await via async wrapper; `tool.*` proxy via `fetch`.               |
| `types.ts`     | Wire protocol types: `Cell`, `CellResult`, `KernelRequest`/`Event`, `BridgeRequest`/`Response`. |
| `eval.test.ts` | `node:test` suite for bridge auth + both kernels.                                               |

## Invariants to preserve

- **State persistence.** Python: any top-level binding survives across cells/calls. JS: only `globalThis`/`state` writes persist — cell-local `let`/`const` don't. No shared variables across languages (hand off via a file). Preserve this contract when touching either kernel.
- **Crash resilience.** A dead Python kernel (OOM, segfault, `os._exit`) is detected via `PyKernel.alive` and respawned transparently on the next cell — never left throwing for the rest of the session. Stdin EPIPE is guarded (finalize pending + respawn, never a process-wide `uncaughtException`). `runner.py` runs a parent-watchdog that `os._exit`s on reparent, so kernels don't leak past a host SIGKILL. Timeout escalation: SIGINT first (state preserved), kill + respawn only if ignored for 2s.
- **Host-crash containment.** The eval extension is the only `unhandledRejection` handler pi installs; it logs and swallows, never re-throws. `execute()` is wrapped so failures return as a normal tool error, never a rejection (a rejected `execute()` can escalate to a pi crash). The handler is de-duplicated across hot reloads (`process.off` before `process.on`).
- **Python venv.** Managed at `~/.cache/pi-eval/venv`, pinned to `PYTHON_VERSION` in `py-kernel.ts`. A minor-pin bump wipes and recreates it (reinstall via `install()`); patch upgrades flow through automatically.

## Adding a tool cells can call

**Extension tools** (normal case): the producer extension calls `exposeRegisteredToolsToEval(pi)` (`../shared/bridge-tools.ts`) once at the top of its `default()` — everything it registers becomes callable as `tool.<name>()`. A raw `pi.registerTool` without this call is invisible to cells. The registry lives on `globalThis` (pi loads each extension in an isolated module graph) and is process-wide, so tool names must stay unique across extensions.

**Host-side capabilities that aren't tools** (shell pipelines, external APIs): add a `case` arm in `bridgeHandler` in `index.ts` instead — see any existing arm (e.g. `completion`) as a template.

## Deliberate non-goals

Not supported, by design, cost disproportionate to value for a personal setup:

- IPython kernel (rich display, e.g. pandas → HTML) — raw `python3 -u exec()` only, text repr.
- JS top-level `import x from "pkg"` statement form — `node:vm` cells aren't modules. `require(...)` and `await import(...)` both work at runtime.
- A `task`-style tool returning schema-validated subagent output.
- Forwarding MCP tools through `tool.*`.
- Per-bridge-call TUI status events (only emitted between cells, not per `tool.*` call).

`README.md` in this folder does not exist — this file is the single source of truth for both maintainers and the model (`folder-context.ts` loads only `AGENTS.md`).
