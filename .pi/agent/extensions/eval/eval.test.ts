// Tests for the eval extension. Run with:
//   node --experimental-strip-types --test eval/eval.test.ts
// Zero npm deps — uses node:test + node:assert/strict.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { registerBridgeSession, setBridgeSignal } from "./bridge.ts";
import { PyKernel } from "./py-kernel.ts";
import { JsKernel } from "./js-kernel.ts";

// Bridge handler shared by py and js kernel tests: exposes one fake tool that
// doubles a number, so cells can verify the bridge round-trip works.
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
  const reg = await registerBridgeSession(doubleHandler);
  return new Cls({
    bridgeUrl: reg.url,
    bridgeToken: reg.token,
    bridgeSession: reg.session,
  });
}

describe("bridge", () => {
  it("rejects requests without a valid bearer token", async () => {
    const reg = await registerBridgeSession(async () => "never reached");
    const res = await fetch(`${reg.url}/v1/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: reg.session, name: "x", args: {} }),
    });
    assert.equal(res.status, 403);
    reg.unregister();
  });

  it("dispatches authorized POST to the registered handler", async () => {
    const reg = await registerBridgeSession(async (name, args) => ({
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
    const reg = await registerBridgeSession(async () => {
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

  it("forwards the current bridge signal to the handler", async () => {
    let received: AbortSignal | undefined;
    const reg = await registerBridgeSession(async (_n, _a, signal) => {
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

  it("reset wipes the kernel globals", async () => {
    const k = await make();
    await k.run("x = 99", 5, undefined);
    await k.reset();
    const r = await k.run("'x' in dir()", 5, undefined);
    assert.equal(r.value, false);
  });
});

describe("JsKernel", () => {
  const kernels: JsKernel[] = [];
  const make = async () => {
    const k = await makeKernel(JsKernel);
    kernels.push(k);
    return k;
  };

  after(() => {
    for (const k of kernels) k.dispose();
  });

  it("runs a cell and auto-returns the last expression", async () => {
    const k = await make();
    const r = await k.run("2 + 2", 5, undefined);
    assert.equal(r.value, 4);
  });

  it("captures console.log via tick", async () => {
    const k = await make();
    const chunks: string[] = [];
    const r = await k.run(
      "console.log('a'); console.log('b'); 1",
      5,
      undefined,
      (partial) => chunks.push(partial.stdout),
    );
    assert.equal(r.stdout, "a\nb\n");
    assert.ok(chunks.length >= 1);
  });

  it("persists state across cells via globalThis", async () => {
    const k = await make();
    await k.run("globalThis.x = 41", 5, undefined);
    const r = await k.run("x + 1", 5, undefined);
    assert.equal(r.value, 42);
  });

  it("supports top-level await", async () => {
    const k = await make();
    const r = await k.run(
      "const v = await Promise.resolve(7); v",
      5,
      undefined,
    );
    assert.equal(r.value, 7);
  });

  it("calls back into the host via tool.<name>(args)", async () => {
    const k = await make();
    const r = await k.run(
      "const y = await tool.double({x: 21}); y",
      5,
      undefined,
    );
    assert.equal(r.value, 42);
  });

  it("captures thrown errors", async () => {
    const k = await make();
    const r = await k.run("throw new Error('boom')", 5, undefined);
    assert.match(r.error ?? "", /boom/);
  });

  it("tool proxy ignores poison keys (toJSON / then / inspect)", async () => {
    // Regression: JSON.stringify(globalThis) used to call tool.toJSON() which
    // fired a bridge request with name=toJSON and threw an unhandled rejection.
    const k = await make();
    const r = await k.run(
      "JSON.stringify({hasToJSON: typeof tool.toJSON, hasThen: typeof tool.then})",
      5,
      undefined,
    );
    assert.equal(r.error, null);
    assert.equal(
      r.value,
      JSON.stringify({ hasToJSON: "undefined", hasThen: "undefined" }),
    );
  });

  it("globalThis / state does not enumerate tool scaffolding", async () => {
    const k = await make();
    const r = await k.run(
      "Object.keys(globalThis).filter(k => k === 'tool' || k === '__emit_display')",
      5,
      undefined,
    );
    // r.value is an Array from the vm realm, so deepStrictEqual mismatches on
    // prototype. Compare via JSON form instead.
    assert.equal(JSON.stringify(r.value), "[]");
  });
});
