import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import {
  registerBridgeSession,
  setBridgeSignal,
  type BridgeRegistration,
} from "./bridge.ts";
import EvalExtension from "./index.ts";
import { PyKernel } from "./py-kernel.ts";

const registrations: BridgeRegistration[] = [];
const extensionCleanups = new Set<() => unknown>();

async function register(handler: Parameters<typeof registerBridgeSession>[0]) {
  const reg = await registerBridgeSession(handler);
  registrations.push(reg);
  return reg;
}

afterEach(() => {
  for (const cleanup of extensionCleanups) cleanup();
  extensionCleanups.clear();
  for (const reg of registrations.splice(0)) reg.unregister();
});

const doubleHandler = async (name: string, args: unknown) => {
  if (name === "double") return Number((args as { x: number }).x) * 2;
  throw new Error("unknown");
};

async function makeKernel<K>(
  Cls: new (opts: {
    bridgeUrl: string;
    bridgeToken: string;
    bridgeSession: string;
  }) => K,
): Promise<K> {
  const reg = await register(doubleHandler);
  return new Cls({
    bridgeUrl: reg.url,
    bridgeToken: reg.token,
    bridgeSession: reg.session,
  });
}

describe("bridge", () => {
  it("rejects requests without a valid bearer token", async () => {
    const reg = await register(async () => "never reached");
    const res = await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: reg.session, name: "x", args: {} }),
    });
    assert.equal(res.status, 403);
    reg.unregister();
  });

  it("dispatches authorized POST to the registered handler", async () => {
    const reg = await register(async (name, args) => ({
      echoed: { name, args },
    }));
    const res = await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({
        session: reg.session,
        name: "ping",
        args: { a: 1 },
      }),
    });
    const body = (await res.json()) as { ok: boolean; value: unknown };
    assert.equal(body.ok, true);
    assert.deepEqual(body.value, { echoed: { name: "ping", args: { a: 1 } } });
    reg.unregister();
  });

  it("returns error JSON when handler throws", async () => {
    const reg = await register(async () => {
      throw new Error("boom");
    });
    const res = await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ session: reg.session, name: "x", args: {} }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /boom/);
    reg.unregister();
  });

  it("returns 400 for an authenticated malformed body", async () => {
    const reg = await register(async () => "never reached");
    const res = await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ session: reg.session, name: "x", args: [] }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /object args/);
  });

  it("forwards the current bridge signal to the handler", async () => {
    let received: AbortSignal | undefined;
    const reg = await register(async (_n, _a, signal) => {
      received = signal;
      return null;
    });
    const ac = new AbortController();
    setBridgeSignal(reg.session, ac.signal);
    await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({ session: reg.session, name: "x", args: {} }),
    });
    assert.equal(received, ac.signal);
    setBridgeSignal(reg.session, undefined);
    reg.unregister();
  });
});

describe("public eval tool", () => {
  function makeTool() {
    const registered: any[] = [];
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const flags = new Map<string, unknown>();
    const fakePi = {
      registerTool: (definition: unknown) => registered.push(definition),
      on: (event: string, handler: (...args: any[]) => unknown) =>
        handlers.set(event, handler),
      registerFlag: (name: string, options: { default?: unknown }) =>
        flags.set(name, options.default),
      getFlag: (name: string) => flags.get(name),
    };
    EvalExtension(fakePi as never);
    const shutdown = () => handlers.get("session_shutdown")?.();
    extensionCleanups.add(shutdown);
    return { definition: registered[0]!, shutdown };
  }

  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
  } as never;

  it("registers a Python-only sequential contract", () => {
    const { definition, shutdown } = makeTool();
    const schema = definition.parameters as any;
    assert.equal(definition.name, "eval");
    assert.equal(definition.executionMode, "sequential");
    assert.equal(schema.additionalProperties, false);
    const cellSchema = schema.properties.cells.items;
    assert.equal(cellSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(cellSchema.properties).sort(), [
      "code",
      "reset",
      "timeout",
      "title",
    ]);
    for (const field of ["cells", "code", "title", "timeout", "reset"]) {
      const schemaField =
        field === "cells"
          ? schema.properties.cells
          : cellSchema.properties[field];
      assert.equal(typeof schemaField.description, "string");
    }
    shutdown();
  });

  it("lists structured results and cell-only tools in the loadout description", () => {
    const { definition, shutdown } = makeTool();
    const bash = {
      name: "bash",
      description: "shell",
      outputSchema: {
        type: "object",
        required: ["output", "exit_code"],
        properties: {
          output: { type: "string" },
          exit_code: { type: "number" },
          full_output_path: { type: "string" },
        },
      },
    };
    const read = { name: "read", description: "read" };
    const mcp = {
      name: "mcp__jira__search",
      description: "Search Jira.\nMore.",
    };
    const lazy = { name: "lazy_tool", description: "Deferred." };
    const callable = [bash, read, definition, mcp, lazy];
    const text = definition.prepareLoadout({
      declared: [bash, read, definition],
      callable,
      registered: callable,
      getExposure: (name: string) =>
        name === "lazy_tool" ? "deferred" : "direct",
      getNamespace: () => undefined,
    }).descriptions.eval as string;
    assert.ok(text.startsWith(definition.description));
    assert.match(
      text,
      /- `bash` -> \{output: str, exit_code: number, full_output_path\?: str\}/,
    );
    assert.doesNotMatch(text, /`read` ->|`eval` ->/);
    assert.match(text, /- `mcp__jira__search`: Search Jira\.\n?/);
    assert.doesNotMatch(text, /More\./);
    assert.doesNotMatch(text, /lazy_tool/);
    shutdown();
  });

  it("persists multi-cell state and supports public reset", async () => {
    const { definition, shutdown } = makeTool();
    const result = await definition.execute(
      "public-persistence",
      { cells: [{ code: "x = 41" }, { code: "x + 1" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /=> 42/);
    const reset = await definition.execute(
      "public-reset",
      { cells: [{ reset: true, code: "'x' in globals()" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(reset.content[0].text, /=> false/);
    shutdown();
  });

  it("says when a new kernel replaces one from earlier eval calls", async () => {
    const { definition, shutdown } = makeTool();
    const earlier = {
      cwd: process.cwd(),
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "toolResult", toolName: "eval" },
          },
        ],
      },
    } as never;
    const fresh = await definition.execute(
      "restart-note",
      { cells: [{ code: "1" }] },
      undefined,
      undefined,
      earlier,
    );
    assert.match(fresh.content[0].text, /kernel restarted/);
    const warm = await definition.execute(
      "restart-note-warm",
      { cells: [{ code: "2" }] },
      undefined,
      undefined,
      earlier,
    );
    assert.doesNotMatch(warm.content[0].text, /kernel restarted/);
    shutdown();
  });

  it("streams the active cell and bounds model-facing output", async () => {
    const { definition, shutdown } = makeTool();
    const updates: string[] = [];
    await definition.execute(
      "public-stream",
      {
        cells: [
          {
            code: "import time\nprint('started', flush=True)\ntime.sleep(0.1)\n'finished'",
          },
        ],
      },
      undefined,
      (update: { content: Array<{ type: string; text?: string }> }) => {
        const text = update.content.find((item) => item.type === "text")?.text;
        if (text) updates.push(text);
      },
      ctx,
    );
    assert.ok(updates.some((text) => text.includes("started")));

    const large = await definition.execute(
      "public-truncation",
      { cells: [{ code: "'x' * 60000" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(large.content[0].text, /Output truncated/);
    assert.ok(Buffer.byteLength(large.content[0].text) <= 50 * 1024);

    const lines = await definition.execute(
      "public-head-tail",
      { cells: [{ code: "for i in range(5000): print(f'line {i}')" }] },
      undefined,
      undefined,
      ctx,
    );
    const out = lines.content[0].text as string;
    assert.match(out, /^line 0$/m);
    assert.match(out, /^line 4999$/m);
    assert.doesNotMatch(out, /^line 2500$/m);
    assert.ok(Buffer.byteLength(out) <= 50 * 1024);
    const saved = lines.details.fullOutputPath as string;
    assert.ok(out.includes(saved));
    const full = await readFile(saved, "utf8");
    assert.match(full, /^line 2500$/m);
    await rm(saved);
    shutdown();
  });

  it("respawns after a kernel crash", async () => {
    const { definition, shutdown } = makeTool();
    const crashed = await definition.execute(
      "public-crash",
      { cells: [{ code: "import os; os._exit(0)" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(crashed.isError, true);
    assert.match(crashed.content[0].text, /kernel exited/);
    const recovered = await definition.execute(
      "public-crash-recovery",
      { cells: [{ code: "6 * 7" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(recovered.content[0].text, /=> 42/);
    shutdown();
  });

  it("reports cell errors as isError with details and skips later cells", async () => {
    const { definition, shutdown } = makeTool();
    const failed = await definition.execute(
      "public-error",
      {
        cells: [{ code: "raise ValueError('boom')" }, { code: "marker = 1" }],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /Cell 1 failed.*ValueError/s);
    assert.ok(failed.details);
    const after = await definition.execute(
      "public-error-check",
      { cells: [{ code: "'marker' in globals()" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.match(after.content[0].text, /=> false/);
    shutdown();
  });

  it("calls session tools through ctx.executeTool with codemode result semantics", async () => {
    const { definition, shutdown } = makeTool();
    const calls: Array<{ name: string; args: unknown }> = [];
    const text = (t: string) => [{ type: "text", text: t }];
    const toolCtx = {
      cwd: process.cwd(),
      sessionManager: { getBranch: () => [] },
      tools: [
        { name: "eval", description: "self", parameters: {} },
        {
          name: "bash",
          description: "shell",
          parameters: {},
          outputSchema: { type: "object" },
        },
        { name: "echo", description: "echo", parameters: {} },
      ],
      executeTool: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "bash") {
          return {
            isError: true,
            result: {
              content: text("exit 3"),
              structuredContent: { output: "x", exit_code: 3 },
            },
          };
        }
        if (args.fail)
          return { isError: true, result: { content: text("nope") } };
        return { isError: false, result: { content: text(`echo:${args.v}`) } };
      },
    } as never;
    const result = await definition.execute(
      "public-nested",
      {
        cells: [
          { code: "tool.bash({'command': 'false'})['exit_code']" },
          { code: "tool.echo(v=1)" },
          {
            code: "r = parallel([('echo', {'v': 2}), ('echo', {'fail': True}), ('echo', {'v': 3})])\n[x if isinstance(x, str) else type(x).__name__ + ':' + str(x) for x in r]",
          },
          {
            code: "names = tool.list(); ('eval' in names, 'echo' in names, 'grep' in names)",
          },
          { code: "tool.describe(name='echo')['output_schema']" },
        ],
      },
      undefined,
      undefined,
      toolCtx,
    );
    const out = result.content[0].text;
    assert.match(out, /\[1\][\s\S]*=> 3/);
    assert.match(out, /=> echo:1/);
    assert.match(out, /"echo:2",\s*"RuntimeError:nope",\s*"echo:3"/);
    assert.match(out, /false,\s*true,\s*true/);
    assert.match(out, /"type": "string"/);
    assert.equal(calls.filter((c) => c.name === "echo").length, 4);
    assert.doesNotMatch(out, /not undone/);

    const failed = await definition.execute(
      "public-call-log",
      {
        cells: [
          { code: "tool.echo(v=1); tool.echo(v=2)" },
          { code: "tool.echo(fail=True)" },
        ],
      },
      undefined,
      undefined,
      toolCtx,
    );
    assert.equal(failed.isError, true);
    assert.match(
      failed.content[0].text,
      /Cell 2 failed\. 2\/2 cells ran in [\d.]+s\.\nTool calls made before the failure \(they are not undone\): echo \(ok\) x2, echo \(error\)\./,
    );
    shutdown();
  });
});

describe("PyKernel", () => {
  const kernels: PyKernel[] = [];
  const make = async () => {
    const k = await makeKernel(PyKernel);
    await k.ready();
    kernels.push(k);
    return k;
  };

  after(() => {
    for (const k of kernels) k.dispose();
  });

  it("runs a cell and captures the last expression value", async () => {
    const k = await make();
    const r = await k.run("2 + 2", 5, undefined);
    assert.equal(r.value, 4);
    assert.equal(r.error, null);
  });

  it("captures stdout from print()", async () => {
    const k = await make();
    const r = await k.run("print('hello world')", 5, undefined);
    assert.equal(r.stdout, "hello world\n");
  });

  it("persists state across cells", async () => {
    const k = await make();
    await k.run("x = 41", 5, undefined);
    const r = await k.run("x + 1", 5, undefined);
    assert.equal(r.value, 42);
  });

  it("captures errors as traceback strings", async () => {
    const k = await make();
    const r = await k.run("1/0", 5, undefined);
    assert.equal(r.value, null);
    assert.match(r.error ?? "", /ZeroDivisionError/);
  });

  it("calls back into the host via tool.<name>(args)", async () => {
    const k = await make();
    const r = await k.run("tool.double({'x': 21})", 5, undefined);
    assert.equal(r.value, 42);
  });

  it("invokes onProgress as stdout streams", async () => {
    const k = await make();
    const chunks: string[] = [];
    await k.run(
      "import sys, time\nfor i in range(3):\n    print(i, flush=True)\n",
      5,
      undefined,
      (partial) => chunks.push(partial.stdout),
    );
    assert.ok(chunks.length >= 1);
    assert.equal(chunks.at(-1), "0\n1\n2\n");
  });

  it("marks a crashed kernel dead", async () => {
    const k = await make();
    assert.equal(k.alive, true);
    const dead = await k.run("import os; os._exit(0)", 5, undefined);
    assert.match(dead.error ?? "", /exited with code 0 mid-run/);
    assert.equal(k.alive, false);
  });

  it("soft-interrupts a timed-out cell and preserves kernel state", async () => {
    const k = await make();
    await k.run("marker = 123", 5, undefined);
    const r = await k.run("import time\ntime.sleep(60)", 1, undefined);
    assert.equal(r.timedOut, true);
    assert.match(r.error ?? "", /kernel state preserved/);
    assert.equal(k.alive, true);
    const after = await k.run("marker", 5, undefined);
    assert.equal(after.value, 123);
  });

  it("escalates to kill when the interrupt is ignored", async () => {
    const k = await make();
    const r = await k.run(
      "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ntime.sleep(60)",
      1,
      undefined,
    );
    assert.equal(r.timedOut, true);
    assert.match(r.error ?? "", /interrupt ignored/);
    assert.equal(k.alive, false);
  });

  it("aborts a running cell without marking it timed out", async () => {
    const k = await make();
    await k.run("marker = 123", 5, undefined);
    const ac = new AbortController();
    const running = k.run(
      "import time\ntime.sleep(60)",
      30,
      undefined,
      undefined,
      ac.signal,
    );
    setTimeout(() => ac.abort(), 100);
    const r = await running;
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, undefined);
    assert.match(r.error ?? "", /aborted/);
    assert.equal(k.alive, true);
    assert.equal((await k.run("marker", 5, undefined)).value, 123);
  });

  it("serializes non-finite values as a fallback", async () => {
    const k = await make();
    const r = await k.run("float('nan')", 5, undefined);
    assert.equal(r.error, null);
    assert.equal(r.value, "nan");
  });
});
