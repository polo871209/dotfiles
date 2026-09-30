# eval

Persistent Python extension for iterative computation and aggregation. `index.ts` owns one lazy session state per extension factory, bridge lifecycle, nested tool calls, sequential cells, and model-facing formatting. `py-kernel.ts` manages the `python3 -u runner.py` child, JSONL protocol, timeout/cancellation, and recovery. `bridge.ts` serves authenticated loopback callbacks. `prelude.py` provides Python helpers, synchronous `tool.<name>(args)` calls, and threaded `parallel()`.

## Test

From `.pi/agent/extensions/`:

```sh
node --experimental-strip-types --test eval/eval.test.ts
```

## Invariants

- Python state survives cells and calls until public `reset` recycles the kernel.
- Cells run sequentially and stop at the first error; kernel state survives soft interrupts when possible.
- Abort sends SIGINT first and kills after the two-second grace period if ignored; timeout and abort remain distinct.
- Kernel cwd and fallback/bridge bindings follow `ctx.cwd`; cwd changes recycle them.
- Bridge requests require bearer auth and an object body with string `session`/`name` and object `args`.
- Final and streamed text is bounded with a summary and tail; large aggregates should be summarized or written to a file. Successful image displays remain image content.
- Details contain compact execution metadata, not cell payloads.
- Installed Python packages persist in the managed venv.

## Callable tools

`tool.<name>` runs any tool in `ctx.tools` except `eval` through `ctx.executeTool`, so validation, `tool_call` hooks, nested-call records, and usage match a model-issued call. Do not call a tool's `execute` directly, because that skips the edit guard and permission hooks. The only exception is `read`, `grep`, `find`, and `ls` when they are inactive, because they are read-only.

Results follow codemode's contract. A tool with `outputSchema` returns `structuredContent`, even on `isError`, so `tool.bash` returns `exit_code` instead of raising. Any other tool returns its text, and a failed call raises. `tool.list` and `tool.describe` resolve before real tool names.

`prepareLoadout` appends to the static `DESCRIPTION` only what the declared schemas cannot show: result types of `outputSchema` tools and callable tools that are not declared. Do not render full declarations of declared tools, because the model already sees them and every token repeats on each turn.

## Non-goals

No IPython display system, sandboxing, or task-style schema validation. Results remain text-oriented apart from structured tool values and successful image displays.
