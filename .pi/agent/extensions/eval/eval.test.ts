// Tests for the eval extension. Run with:
//   node --experimental-strip-types --test eval/eval.test.ts

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerBridgeSession,
  setBridgeSignal,
  type BridgeRegistration,
} from "./bridge.ts";
import EvalExtension from "./index.ts";
import {
  exposeRegisteredToolsToEval,
  evalBridgeTools,
} from "../shared/bridge-tools.ts";
import { PyKernel } from "./py-kernel.ts";

const registrations: BridgeRegistration[] = [];
const fakeRegistryNames = new Set<string>();
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
  const registry = evalBridgeTools() as Map<string, unknown>;
  for (const name of fakeRegistryNames) registry.delete(name);
  fakeRegistryNames.clear();
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

describe("bridge-tools registry", () => {
  it("captures tools registered through a wrapped ExtensionAPI", () => {
    const registered: unknown[] = [];
    const fakePi = {
      registerTool: (def: unknown) => registered.push(def),
    };
    exposeRegisteredToolsToEval(fakePi as never);
    (fakePi.registerTool as (def: unknown) => void)({
      name: "fake_bridged_tool",
      execute: async () => ({ content: [] }),
    });
    assert.equal(registered.length, 1);
    assert.ok(evalBridgeTools().has("fake_bridged_tool"));
    fakeRegistryNames.add("fake_bridged_tool");
  });
});

describe("public eval tool", () => {
  function makeTool() {
    const registered: any[] = [];
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const fakePi = {
      registerTool: (definition: unknown) => registered.push(definition),
      on: (event: string, handler: (...args: any[]) => unknown) =>
        handlers.set(event, handler),
    };
    EvalExtension(fakePi as never);
    const shutdown = () => handlers.get("session_shutdown")?.();
    extensionCleanups.add(shutdown);
    return { definition: registered[0]!, shutdown };
  }

  const ctx = { cwd: process.cwd() } as never;

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
    shutdown();
  });

  it("respawns after a kernel crash", async () => {
    const { definition, shutdown } = makeTool();
    await assert.rejects(
      definition.execute(
        "public-crash",
        { cells: [{ code: "import os; os._exit(0)" }] },
        undefined,
        undefined,
        ctx,
      ),
      /kernel exited/,
    );
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

  it("throws cell errors and does not run subsequent cells", async () => {
    const { definition, shutdown } = makeTool();
    await assert.rejects(
      definition.execute(
        "public-error",
        {
          cells: [{ code: "raise ValueError('boom')" }, { code: "marker = 1" }],
        },
        undefined,
        undefined,
        ctx,
      ),
      /Cell 1 failed.*ValueError/s,
    );
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
