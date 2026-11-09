import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DevtoolsRecorder } from "./devtools.ts";

const USER_DATA_DIR = join(
  homedir(),
  "Library/Application Support/net.imput.helium",
);

const children = new Set<ChildProcess>();
const killChild = () => {
  for (const child of children) child.kill();
};
process.on("exit", killChild);

const READ_STATE = await readFile(
  join(import.meta.dirname, "snapshot.js"),
  "utf-8",
);
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

// Adapted from https://github.com/browser-use/jev-ultrafast/blob/8251e272398011cdef648965204d1c20cd838333/jev_ultrafast/browser.py (MIT, Browser Use)
const SETTLE = `(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

const RESOLVE_TARGET = `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})`;

export class StalePage extends Error {}

/** The tab stopped answering CDP calls. */
export class TabHung extends Error {}

export interface Action {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  delta?: number;
}

export interface Page {
  url: string;
  title: string;
  text: string;
  actions: Action[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  scroll: { y: number; height: number };
  fingerprint: string;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class Cdp {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  onEvent?: (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void;

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        this.onEvent?.(message.method, message.params, message.sessionId);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    };
    ws.onclose = () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error("Helium closed the CDP connection"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`No CDP connection to Helium within 30 s`));
      }, 30_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to ${url}`));
      };
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TabHung(`${method} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws.close();
  }
}

interface LoadState {
  ready: string;
  title: string;
  text: string;
}

interface Evaluated {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

export interface Profile {
  dir: string;
  name: string;
}

/** Resolves a Helium profile by its display name or directory. Without a request, picks the profile Helium used last. */
export async function resolveProfile(requested?: string): Promise<Profile> {
  const state = JSON.parse(
    await readFile(join(USER_DATA_DIR, "Local State"), "utf-8"),
  ) as {
    profile: { info_cache: Record<string, { name: string }>; last_used?: string };
  };
  const profiles = Object.entries(state.profile.info_cache).map(
    ([dir, info]) => ({ dir, name: info.name }),
  );
  const wanted = (requested ?? state.profile.last_used ?? "Default").toLowerCase();
  const profile = profiles.find(
    (p) => p.name.toLowerCase() === wanted || p.dir.toLowerCase() === wanted,
  );
  if (!profile)
    throw new Error(
      `Helium has no profile "${requested}". Profiles: ${profiles.map((p) => p.name).join(", ")}.`,
    );
  return profile;
}

async function runningHeliumPid(): Promise<number | undefined> {
  const lock = await readlink(join(USER_DATA_DIR, "SingletonLock")).catch(
    () => undefined,
  );
  const pid = Number(lock?.split("-").at(-1));
  if (!Number.isInteger(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function readEndpoint(): Promise<string | undefined> {
  const lines = await readFile(
    join(USER_DATA_DIR, "DevToolsActivePort"),
    "utf-8",
  ).then(
    (text) => text.split("\n"),
    () => [],
  );
  return lines[1] ? `ws://127.0.0.1:${lines[0]}${lines[1]}` : undefined;
}

/** One tab in Helium: a background tab of the open Helium, or a headless Helium started on the chosen profile. */
export class Helium {
  private afterInput: Action | undefined;
  private recorder: DevtoolsRecorder | undefined;

  private session = "";
  private targetId = "";

  private constructor(
    private readonly cdp: Cdp,
    readonly label: string,
    private readonly child?: ChildProcess,
    private readonly userAgent?: string,
  ) {}

  static async open(profile: Profile, explicit: boolean): Promise<Helium> {
    if (await runningHeliumPid()) {
      if (explicit)
        throw new Error(
          `Helium is open, so the browser tool cannot switch to the "${profile.name}" profile. Quit Helium and try again.`,
        );
      const endpoint = await readEndpoint();
      const cdp = endpoint && (await Cdp.connect(endpoint).catch(() => undefined));
      if (!cdp)
        throw new Error(
          "Helium is open without remote debugging. Turn it on at chrome://inspect/#remote-debugging in Helium, or quit Helium.",
        );
      const helium = new Helium(cdp, "open Helium");
      await helium.openTab();
      return helium;
    }

    await rm(join(USER_DATA_DIR, "DevToolsActivePort"), { force: true });
    const child = spawn(
      "/Applications/Helium.app/Contents/MacOS/Helium",
      [
        "--headless=new",
        "--disable-blink-features=AutomationControlled",
        "--remote-debugging-port=0",
        `--user-data-dir=${USER_DATA_DIR}`,
        `--profile-directory=${profile.dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    children.add(child);
    let exit: string | undefined;
    child.once("exit", (code) => {
      exit = `Helium exited with code ${code}`;
      children.delete(child);
    });
    child.once("error", (error) => (exit = error.message));

    let endpoint: string | undefined;
    for (let waited = 0; !endpoint && !exit && waited < 15_000; waited += 50) {
      endpoint = await readEndpoint();
      if (!endpoint) await sleep(50);
    }
    if (!endpoint) {
      child.kill();
      throw new Error(exit ?? "Helium did not open a CDP port within 15 s.");
    }
    const cdp = await Cdp.connect(endpoint);
    const { userAgent } = await cdp.send<{ userAgent: string }>(
      "Browser.getVersion",
    );
    const helium = new Helium(
      cdp,
      profile.name,
      child,
      userAgent.replace("HeadlessChrome", "Chrome"),
    );
    await helium.openTab();
    return helium;
  }

  private async openTab() {
    const { targetId } = await this.cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank", background: !this.child },
    );
    const { sessionId } = await this.cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    this.targetId = targetId;
    this.session = sessionId;
    this.afterInput = undefined;
    this.cdp.onEvent = (method, params, eventSession) => {
      if (eventSession === this.session) this.recorder?.handle(method, params);
    };
    if (this.recorder) await this.enableDevtools();
    await this.call("Emulation.setDeviceMetricsOverride", {
      width: 1120,
      height: 780,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Chromium throttles rendering in unfocused tabs.
    await this.call("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (this.userAgent)
      await this.call("Emulation.setUserAgentOverride", {
        userAgent: this.userAgent,
      });
  }

  private async enableDevtools() {
    await this.call("Runtime.enable");
    await this.call("Log.enable");
    await this.call("Network.enable");
  }

  /** Records console messages and network requests of this tab until `stopDevtools()`. */
  async recordDevtools(): Promise<DevtoolsRecorder> {
    this.recorder = new DevtoolsRecorder();
    await this.enableDevtools();
    return this.recorder;
  }

  async stopDevtools() {
    this.recorder = undefined;
    await Promise.all(
      ["Runtime.disable", "Log.disable", "Network.disable"].map((method) =>
        this.call(method).catch(() => undefined),
      ),
    );
  }

  private async replaceTab() {
    await this.cdp
      .send("Target.closeTarget", { targetId: this.targetId })
      .catch(() => undefined);
    await this.openTab();
  }

  /** Replaces a hung tab with a new one on the same URL. */
  async recover(url: string) {
    await this.replaceTab();
    await this.navigate(url);
  }

  async close() {
    await this.cdp
      .send("Target.closeTarget", { targetId: this.targetId })
      .catch(() => undefined);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      await this.cdp.send("Browser.close").catch(() => child.kill());
      await Promise.race([exited, sleep(5_000)]);
      child.kill();
    }
    this.cdp.close();
  }

  private call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5_000,
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.session, timeoutMs);
  }

  private async evaluate(
    expression: string,
    awaitPromise = false,
  ): Promise<unknown> {
    let response: Evaluated;
    try {
      response = await this.call<Evaluated>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
      });
    } catch (error) {
      if (error instanceof TabHung) throw error;
      throw new StalePage("Document changed during evaluation");
    }
    if (response.exceptionDetails)
      throw new StalePage("Document changed during evaluation");
    return response.result?.value;
  }

  async navigate(url: string) {
    let before: LoadState | undefined;
    try {
      before = await this.loadState();
    } catch (error) {
      if (error instanceof TabHung) await this.replaceTab();
    }
    let navigation: { loaderId?: string; errorText?: string };
    try {
      navigation = await this.call("Page.navigate", { url }, 10_000);
    } catch (error) {
      if (!(error instanceof TabHung)) throw error;
      await this.replaceTab();
      navigation = await this.call("Page.navigate", { url }, 10_000);
    }
    if (navigation.errorText)
      throw new Error(`Cannot open ${url}: ${navigation.errorText}`);
    // A same-document navigation, such as a hash change, has no loader and keeps readyState "complete".
    await this.settle(navigation.loaderId === undefined ? before : undefined);
  }

  private async loadState(): Promise<LoadState | undefined> {
    try {
      return (await this.evaluate(
        `({ ready: document.readyState, title: document.title, text: document.body?.innerText ?? "" })`,
      )) as LoadState;
    } catch (error) {
      if (error instanceof TabHung) throw error;
      return undefined;
    }
  }

  private async settle(previous?: LoadState) {
    let last: string | undefined;
    let changedAt = Date.now();
    let loadedAt: number | undefined;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      const state = await this.loadState();
      const content = state && `${state.title}\n${state.text}`;
      if (content !== last) changedAt = Date.now();
      last = content;
      if (state?.ready === "complete") {
        loadedAt ??= Date.now();
        const quietFor =
          !previous || state.title !== previous.title ? 300 : 1_000;
        const changed =
          !previous || content !== `${previous.title}\n${previous.text}`;
        if (changed && Date.now() - changedAt >= quietFor) return;
        if (Date.now() - loadedAt > 3_000) return;
      }
      await sleep(100);
    }
  }

  async observe(): Promise<Page> {
    const action = this.afterInput;
    this.afterInput = undefined;
    if (action)
      await this.evaluate(`${SETTLE}(${JSON.stringify(action)})`, true).catch(
        (error) => {
          if (error instanceof TabHung) throw error;
        },
      );
    for (const deadline = Date.now() + 5_000; ; ) {
      try {
        const info = (await this.evaluate(READ_STATE)) as Omit<
          Page,
          "fingerprint"
        > | null;
        if (!info) throw new StalePage("Document is navigating");
        const content = JSON.stringify([
          info.url,
          info.text,
          info.actions,
          info.scroll,
        ]);
        return {
          ...info,
          fingerprint: createHash("sha256").update(content).digest("hex"),
        };
      } catch (error) {
        if (!(error instanceof StalePage) || Date.now() > deadline)
          throw error;
        await sleep(50);
      }
    }
  }

  async fresh(page: Page, action?: Action): Promise<boolean> {
    if (action?.kind === "click" || action?.kind === "select") {
      if (!Number.isInteger(action.node)) return false;
      const current = await this.evaluate(
        `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`,
      );
      return (
        JSON.stringify(current) ===
        JSON.stringify([page.page_key, page.guards[String(action.node)]])
      );
    }
    return (
      JSON.stringify(await this.evaluate(MARKER)) ===
      JSON.stringify(page.marker)
    );
  }

  async act(action: Action, page: Page, text?: string) {
    if (!(await this.fresh(page, action)))
      throw new StalePage("Page changed since this decision. Observe again.");
    if (action.kind === "wait") {
      await sleep(100);
      return;
    }
    if (action.kind === "scroll") {
      await this.call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 550,
        y: 650,
        deltaX: 0,
        deltaY: action.delta,
      });
      this.afterInput = action;
      return;
    }
    if (!Number.isInteger(action.node))
      throw new Error("Invalid observed node");
    let target: { x: number; y: number } | null;
    try {
      target = (await this.evaluate(
        `${RESOLVE_TARGET}(${JSON.stringify(action)})`,
      )) as { x: number; y: number } | null;
    } catch (error) {
      if (action.kind === "select")
        throw new Error(
          "Dropdown execution was interrupted; inspect before retrying.",
        );
      throw error;
    }
    if (!target) {
      if (action.kind === "select")
        throw new Error(
          "Dropdown execution was not confirmed; inspect before retrying.",
        );
      throw new StalePage("Target changed or is covered. Observe again.");
    }
    if (action.kind !== "select") {
      for (const type of ["mousePressed", "mouseReleased"])
        await this.call("Input.dispatchMouseEvent", {
          type,
          x: target.x,
          y: target.y,
          button: "left",
          clickCount: 1,
        });
      if (action.kind === "fill") {
        const modifiers = process.platform === "darwin" ? 4 : 2;
        await this.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          modifiers,
          commands: ["selectAll"],
        });
        await this.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          modifiers,
        });
        await this.call("Input.insertText", { text });
      }
    }
    this.afterInput = action;
  }
}
