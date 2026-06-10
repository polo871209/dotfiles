# eval — persistent code execution with tool-calling for pi

A pi extension that registers an `eval` tool. The model submits **cells** of Python or JavaScript; cells run in long-lived kernels whose state persists across cells **and across separate `eval` tool calls** within a session. Inside any cell, `tool.<name>(args)` round-trips back into pi's own tools (`read`, `bash`, `grep`, `find`, `edit`, `write`, `ls`) over a token-gated `127.0.0.1` HTTP bridge.

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `eval` tool. Reduced scope, Node-native (pi-mono runs on Node), ~1500 LOC.

## Why use it

Data lives in the kernel, not in conversation context. For "loop over many items, aggregate, return a summary" tasks the savings are 10–100× tokens. See [token economics](#token-economics) below.

| Task shape                 | Direct tools                                               | eval                                                              |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Read 50 files, summarize   | All 50 file contents enter conversation history (~30K tok) | Files read into kernel; only the summary enters history (~50 tok) |
| Multi-step pipeline        | 4–6 tool calls + 4–6 model turns deciding next step        | 1 cell does the whole thing                                       |
| Iterative data exploration | Re-reads file each turn                                    | Read once, query freely from later cells                          |
| Numeric verification       | Model does mental math                                     | Real numbers from real Python                                     |

## Quick start

The extension auto-loads from `~/.pi/agent/extensions/eval/`. The model can invoke:

```json
{
  "tool": "eval",
  "args": {
    "cells": [
      { "language": "py", "code": "import sys; sys.version" },
      { "language": "js", "code": "2 + 2" }
    ]
  }
}
```

## Cell parameters

Each cell:

| Field      | Type             | Description                                                                             |
| ---------- | ---------------- | --------------------------------------------------------------------------------------- |
| `language` | `"py"` \| `"js"` | Which kernel runs it                                                                    |
| `code`     | string           | Source code. Verbatim. Last expression auto-returns as the cell's value (Jupyter-style) |
| `title`    | string?          | Optional label shown in the result                                                      |
| `timeout`  | number?          | Seconds, 1–600, default 30                                                              |
| `reset`    | boolean?         | Wipe this language's kernel before running                                              |

## In-cell API

Same names, same arg order both languages. Python uses keyword args; JavaScript uses a trailing object and helpers are `async` / `await`able.

| Helper                                           | Purpose                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `tool.<name>(args)`                              | POST to the bridge; host runs the named pi tool and returns its result                                       |
| `read(path, offset?, limit?)`                    | Shorthand for `tool.read`                                                                                    |
| `write(path, content)`                           | Shorthand for `tool.write`                                                                                   |
| `tree(path=".", max_depth=3, show_hidden=False)` | ASCII tree (custom, not a pi built-in)                                                                       |
| `display(value)`                                 | Emit a cell display event. Py: matplotlib `Figure` → PNG, else JSON / `repr`. JS: JSON / `String()` fallback |
| `install(*pkgs, upgrade=False)`                  | **Python only.** `uv pip install` into the managed venv. Persists across pi restarts                         |
| `state`                                          | **JS only.** Alias for `globalThis`; preferred way to persist state across JS cells                          |

`tool.<name>(args)` resolves in this order:

1. Pi built-in tools registered at session start: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Arguments match pi's standard schemas. Results are flattened: single text → string, with images → `{text, images}`.
2. Custom fallback: `tree({ path, max_depth, show_hidden })`.

Abort signal from the parent `eval` call is forwarded to built-in tool invocations, so cancelling the agent mid-cell cancels any in-flight `tool.bash` / `tool.grep`.

## Python runtime + packages

The Python kernel runs in a managed venv at **`~/.cache/pi-eval/venv`**, pinned to **Python 3.14** (created via `uv venv --python 3.14`). Created lazily on first kernel boot; reused across all pi sessions on this machine.

Install packages from any cell:

```python
install("feedparser", "rich")
import feedparser
feed = feedparser.parse("https://news.ycombinator.com/rss")
```

Installs land in the shared venv, so they persist across `eval` calls and across pi restarts. Cold install via uv is ~1s for typical packages; subsequent imports are instant.

## State persistence model

- **Python**: any top-level binding (`x = 1`, `def f(): ...`, `import pandas`) survives across cells and across `eval` calls.
- **JavaScript**: bindings declared with `let` / `const` inside a cell are scoped to that cell's async wrapper. Use `globalThis.x = ...` or `state.x = ...` to share across cells.
- **Across languages**: no shared variables. To hand off data, write JSON to a file from one language and read it from the other.

| Across what?                                     | Python state | JS state | Kernel processes | Bridge token | Installed packages |
| ------------------------------------------------ | ------------ | -------- | ---------------- | ------------ | ------------------ |
| Cell → next cell in same `eval` call             | ✓            | ✓        | ✓                | ✓            | ✓                  |
| `eval` call → next `eval` call (same pi session) | ✓            | ✓        | ✓                | ✓            | ✓                  |
| Pi session → next pi session                     | ✗            | ✗        | ✗ (respawn)      | ✗ (regen)    | ✓ (venv on disk)   |

## Examples

### Mixed-language pipeline

```python
# cell 1 — py
install("feedparser")
import feedparser, json
feed = feedparser.parse("https://news.ycombinator.com/rss")
stories = [{"title": e.title, "link": e.link} for e in feed.entries[:10]]
write("/tmp/hn.json", json.dumps(stories))
f"fetched {len(stories)} stories"
```

```javascript
// cell 2 — js, same eval call
const stories = JSON.parse(await read("/tmp/hn.json"));
const md = stories
  .map((s, i) => `${i + 1}. [${s.title}](${s.link})`)
  .join("\n");
console.log(md);
```

### Calling pi's bash + grep over the bridge

```python
# Find all .ts files, count lines via real wc, identify the biggest.
files = tool.bash({"command": "find .pi/agent/extensions/eval -name '*.ts'"}).split()
sizes = [(int(tool.bash({"command": f"wc -l < {f}"}).strip()), f) for f in files]
sorted(sizes, reverse=True)[:3]
```

### Persistent dataset across calls

```python
# eval call 1
import pandas as pd
df = pd.read_csv("/tmp/big.csv")
len(df)
```

```python
# eval call 2 (minutes later, same pi session)
df.groupby("category").size().to_dict()  # df is still loaded
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  pi process (Node)                                              │
│                                                                 │
│   conversation history ──── billed by LLM API                   │
│      user, assistant, tool result text                          │
│                                                                 │
│   eval extension (TypeScript)                                   │
│     index.ts      ─ registers tool, wires kernels + bridge      │
│     bridge.ts     ─ node:http server on 127.0.0.1:RANDOM        │
│     py-kernel.ts  ─ manages python3 subprocess                  │
│     js-kernel.ts  ─ runs cells in node:vm context               │
└──────────────────┬──────────────────────────────────────────────┘
                   │ stdin / fd 3 pipes
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  python3 subprocess  (~/.cache/pi-eval/venv/bin/python)         │
│                                                                 │
│   runner.py       ─ reads {id,op,code} JSON lines on stdin,     │
│                     execs into globals_dict, emits stream/      │
│                     display/done events on fd 3                 │
│   prelude.py      ─ defines tool proxy + read/write/tree/       │
│                     display/install, exec'd into globals at     │
│                     kernel boot                                 │
│                                                                 │
│   globals_dict { x, df, pd, … }   ◄── NOT billed, never seen    │
│                                       by the LLM                │
└─────────────────────────────────────────────────────────────────┘
        │                                       ▲
        │  tool.X(args) → urllib POST           │
        │  http://127.0.0.1:RANDOM/v1/tool      │
        │  Authorization: Bearer <token>        │
        └───────────────────────────────────────┘  loopback bridge
```

Three communication channels:

| Pipe          | Direction     | What flows                                                  |
| ------------- | ------------- | ----------------------------------------------------------- |
| stdin         | Node → Python | one JSON request per line: `{id, op, code}`                 |
| fd 3          | Python → Node | events: `stream` (live stdout), `display`, `done`           |
| loopback HTTP | Python → Node | `tool.<name>(args)` calls — separate channel for the bridge |

The JS kernel runs in-process (`node:vm` context) but uses the same loopback HTTP bridge for `tool.*` calls, so both languages share one bridge server per session.

## Files

| File           | LOC  | Role                                                                                                                                                                                                                                                                             |
| -------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | ~310 | Extension entry. Registers tool, manages per-session kernels + bridge lifecycle, routes cells by language, forwards pi built-ins via `createXxxTool` factories.                                                                                                                  |
| `bridge.ts`    | ~130 | Single shared `node:http` server on a random loopback port. Multiplexes sessions by id; bearer-token gated. `server.unref()` so it never holds the event loop alone.                                                                                                             |
| `py-kernel.ts` | ~230 | Spawns `python3 -u runner.py` from the managed venv, JSON-line stdin protocol + fd 3 events. Streams stdout / stderr / display to the host via `onProgress` callback. Handles timeout (kill + respawn), reset, and exposes `alive` so a dead kernel is recycled on the next run. |
| `runner.py`    | ~120 | Long-lived Python loop. Reads stdin JSON, execs cells with stdout/stderr redirected to fd 3, emits stream / display / done. Captures last expression value via AST.                                                                                                              |
| `prelude.py`   | ~140 | Defines `tool` proxy (over urllib), `display`, `read`, `write`, `tree`, `install`. Exec'd into globals at kernel boot.                                                                                                                                                           |
| `js-kernel.ts` | ~280 | `node:vm` context per session; each cell wrapped as `(async () => {…})()` for top-level await; last-expression auto-return via heuristic; `tool.*` proxy via global `fetch` (with `Connection: close` to avoid keep-alive).                                                      |
| `types.ts`     | ~55  | Wire protocol types: `Cell`, `CellResult`, `KernelRequest`, `KernelEvent`, `BridgeRequest`, `BridgeResponse`.                                                                                                                                                                    |
| `eval.test.ts` | ~250 | `node:test` suite — bridge auth, py kernel (state/stdout/errors/tool callback/onProgress/reset), js kernel (top-level await/state/console/tool callback/errors).                                                                                                                 |

## Tests

Zero-dep test suite using `node:test` + `node:assert/strict`. Run from the extensions dir:

```sh
cd ~/dotfiles/.pi/agent/extensions
node --experimental-strip-types --test eval/eval.test.ts
```

Completes in ~0.35s. `bridge.ts` calls `server.unref()` and `js-kernel.ts` uses `Connection: close` headers so the test process exits cleanly instead of waiting on undici keep-alive.

## Token economics

Why "data in kernel" matters. A concrete example — "find the 3 largest files in dotfiles":

**Without eval** (using `bash ls -laS | head` and friends):

- Tool result enters conversation: 3,000-line directory listing.
- ~30,000 tokens added to context.
- Multiplied by every subsequent turn (history is resent on each LLM call).
- 20-turn session: 600,000 tokens cumulative.

**With eval**:

- Python walks the dir, sorts by size, returns top 3.
- Tool result enters conversation: 3 lines.
- ~60 tokens added to context.
- 20-turn session: 1,200 tokens cumulative.

The 3,000-line raw data **lives in the Python subprocess's RAM**, never crosses into pi's conversation history, never reaches the LLM API. Only what the cell explicitly `return`s or `print`s crosses the bridge back.

## Phase status

- ✅ Phase 1: Python kernel, bridge, read/write/tree, display, timeout, reset.
- ✅ Phase 2: JS kernel (`node:vm`), top-level await, last-expression auto-return, cross-language handoff.
- ✅ Phase 3: Pi built-in tool forwarding (read/write/edit/bash/grep/find/ls), abort signal plumbing, progressive `onUpdate` results.
- ✅ Phase 4: Managed Python 3.14 venv at `~/.cache/pi-eval/venv`, `install()` helper.
- ✅ Phase 5: Live stdout streaming (per-write `onProgress`), `node:test` suite.
- ✅ Phase 6: Crash resilience — a dead Python kernel (OOM kill, native segfault, `os._exit`, host crash) is detected via `PyKernel.alive` and transparently respawned by `ensurePyKernel` on the next cell, instead of staying cached and throwing `"python kernel has exited"` for the rest of the session. Stdin EPIPE is guarded (finalize pending + respawn, never a process-wide uncaughtException), and `runner.py` runs a parent-watchdog daemon that `os._exit`s when reparented, so kernels don't leak as zombies after a host SIGKILL.
- ✅ Phase 7: Host-crash containment — pi installs **no** `unhandledRejection`/`uncaughtException` handler, so the eval extension's handler is the only one process-wide. It now **logs and swallows** every unhandled rejection (eval-origin or not) and **never re-throws** — the previous `setImmediate(throw)` turned recoverable async hiccups (a dying kernel pipe, an aborted bridge fetch) into hard pi exits. `execute()` is wrapped in a catch-all that returns the failure as a normal tool error (`eval failed (host error): …`) instead of rejecting — a rejected `execute()` surfaces in pi as `"No result provided"` and can escalate to a crash. The handler is also de-duplicated across hot reloads (`process.off` before `process.on`), since a reload re-runs the extension entry without firing `session_shutdown`.

### Crash recovery vs oh-my-pi

Ported from oh-my-pi's kernel lifecycle: instant exit detection + `isAlive()` guard + respawn-on-next-call (their findings #1/#2/#6), stdin EPIPE guard (#3), and the subprocess parent-watchdog (#7). Not ported (deliberate, see gaps below): SIGINT soft-interrupt escalation ladder, heartbeat/idle-timeout split, pre-spawn runtime probe, and the `startingSessions` concurrent-spawn dedup — pi serializes tool calls per session and timeout already falls back to kill+respawn, so the cost outweighs the value for a personal setup.

## What omp does that we don't

These are real gaps. Skipped because the engineering cost was disproportionate to the value for a personal dotfiles setup.

- **IPython kernel.** omp uses real IPython (ZMQ, rich display, soft cell-interrupt). We use raw `python3 -u` with `exec()`. We lose rich display (pandas DataFrame → text repr, not pretty HTML) and timeout means kill + respawn, not soft interrupt.
- **JS static `import` statements.** omp does AST rewriting to support top-level `import x from "pkg"` syntax in JS cells via Bun.Worker. We use `node:vm`, where a cell isn't a module, so the `import ... from` _statement_ form can't work. Runtime module loading does work, though: `require("pkg")` / `require("node:fs")` / `require("/abs/path")` are injected, and `await import("pkg")` resolves through Node's real loader.
- **Subagent integration.** omp's `task` tool returns schema-validated objects; cells read them via `output(taskId)`. We don't have a `task` tool to forward.
- **Forwarding extension/MCP tools.** We forward only the 7 built-ins. Other pi extensions' tools and MCP tools aren't reachable through `tool.*`. To expose one, add an arm to `bridgeHandler` in `index.ts`.
- **TUI rendering polish.** omp renders each cell as a Jupyter-card with title/timing/inline images. We render plain text.
- **Per-bridge-call status events.** omp shows each `tool.read` invocation in the TUI as it fires inside a cell. We only emit between cells.

If you hit one of these walls, see the relevant omp source as a reference port. The bridge mechanism we share is identical; everything above is layered on top of it.

## Extending: adding a custom bridge tool

To make `tool.git_log({n: 30})` callable from cells, add an arm in `bridgeHandler` in `index.ts`:

```ts
case "git_log": {
  const n = Number(args.n ?? 20);
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["log", `-${n}`, "--oneline"], { cwd: state.cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error("git failed")));
  });
  return result;
}
```

The same pattern works for any host-side capability: shell commands, HTTP fetches to external APIs, local LLM calls, anything. Cells just call `tool.git_log({n: 30})` and get the value back.
