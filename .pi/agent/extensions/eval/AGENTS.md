# eval

Persistent Python extension for iterative computation and aggregation. `index.ts` owns one lazy session state per extension factory, bridge lifecycle, cwd-scoped built-ins, sequential cells, and model-facing formatting. `py-kernel.ts` manages the `python3 -u runner.py` child, JSONL protocol, timeout/cancellation, and recovery. `bridge.ts` serves authenticated loopback callbacks. `prelude.py` provides Python helpers and synchronous `tool.<name>(args)` calls.

## Test

From `.pi/agent/extensions/`:

```sh
node --experimental-strip-types --test eval/eval.test.ts
```

## Invariants

- Python state survives cells and calls until public `reset` recycles the kernel.
- Cells run sequentially and stop at the first error; kernel state survives soft interrupts when possible.
- Abort sends SIGINT first and kills after the two-second grace period if ignored; timeout and abort remain distinct.
- Kernel cwd and built-in/bridge bindings follow `ctx.cwd`; cwd changes recycle them.
- Bridge requests require bearer auth and an object body with string `session`/`name` and object `args`.
- Final and streamed text is bounded with a summary and tail; large aggregates should be summarized or written to a file. Successful image displays remain image content.
- Details contain compact execution metadata, not cell payloads.
- Installed Python packages persist in the managed venv.

## Callable tools

Use `tool.list()` to discover bridged tools. Helpers are `read`, `write`, `tree`, `env`, `completion`, and `install`.

## Non-goals

No IPython display system, MCP forwarding, or task-style schema validation. Results remain text-oriented apart from successful image displays.
