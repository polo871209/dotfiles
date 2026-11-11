import { spawn, type ChildProcess } from "node:child_process";
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
const DEVTOOLS_DOMAINS = ["Runtime", "Log", "Network"];

const children = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of children) child.kill();
});

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class Cdp {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  onEvent?: (
    method: string,
    params: Record<string, any>,
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
  ): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer within 15 s`));
      }, 15_000);
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

export interface Profile {
  dir: string;
  name: string;
}

/** Resolves a Helium profile by its display name or directory. Without a request, picks the profile Helium used last. */
export async function resolveProfile(requested?: string): Promise<Profile> {
  const state = JSON.parse(
    await readFile(join(USER_DATA_DIR, "Local State"), "utf-8"),
  ) as {
    profile: {
      info_cache: Record<string, { name: string }>;
      last_used?: string;
    };
  };
  const profiles = Object.entries(state.profile.info_cache).map(
    ([dir, info]) => ({ dir, name: info.name }),
  );
  const wanted = (
    requested ??
    state.profile.last_used ??
    "Default"
  ).toLowerCase();
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

/** The open Helium, or a headless Helium started on the chosen profile. Every tab opened after `open()` renders in the background and can record devtools. */
export class Helium {
  private recorder: DevtoolsRecorder | undefined;
  private readonly sessions = new Set<string>();

  private constructor(
    private readonly cdp: Cdp,
    readonly endpoint: string,
    readonly label: string,
    private readonly child?: ChildProcess,
    private readonly userAgent?: string,
  ) {}

  /** True when this is the user's open Helium, where new tabs must stay in the background. */
  get shared() {
    return this.child === undefined;
  }

  static async open(profile: Profile, explicit: boolean): Promise<Helium> {
    if (await runningHeliumPid()) {
      if (explicit)
        throw new Error(
          `Helium is open, so the browser tool cannot switch to the "${profile.name}" profile. Quit Helium and try again.`,
        );
      const endpoint = await readEndpoint();
      const cdp =
        endpoint && (await Cdp.connect(endpoint).catch(() => undefined));
      if (!endpoint || !cdp)
        throw new Error(
          "Helium is open without remote debugging. Turn it on at chrome://inspect/#remote-debugging in Helium, or quit Helium.",
        );
      const helium = new Helium(cdp, endpoint, "open Helium");
      await helium.watchNewTabs();
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
      endpoint,
      profile.name,
      child,
      userAgent.replace("HeadlessChrome", "Chrome"),
    );
    await helium.watchNewTabs();
    return helium;
  }

  private async watchNewTabs() {
    this.cdp.onEvent = (method, params, sessionId) => {
      if (method === "Target.attachedToTarget") {
        const attached: string = params.sessionId;
        if (params.waitingForDebugger)
          this.prepare(attached)
            .catch(() => undefined)
            .then(() =>
              this.cdp.send("Runtime.runIfWaitingForDebugger", {}, attached),
            )
            .catch(() => undefined);
        else
          this.cdp
            .send("Target.detachFromTarget", { sessionId: attached })
            .catch(() => undefined);
      } else if (method === "Target.detachedFromTarget")
        this.sessions.delete(params.sessionId);
      else if (sessionId && this.sessions.has(sessionId))
        this.recorder?.handle(method, params, sessionId);
    };
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }],
    });
  }

  private async prepare(sessionId: string) {
    this.sessions.add(sessionId);
    // Chromium throttles rendering in background tabs.
    await this.cdp.send(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
      sessionId,
    );
    if (this.userAgent)
      await this.cdp.send(
        "Emulation.setUserAgentOverride",
        { userAgent: this.userAgent },
        sessionId,
      );
    if (this.recorder) await this.toggleDevtools(sessionId, "enable");
  }

  private toggleDevtools(sessionId: string, action: "enable" | "disable") {
    return Promise.all(
      DEVTOOLS_DOMAINS.map((domain) =>
        this.cdp
          .send(`${domain}.${action}`, {}, sessionId)
          .catch(() => undefined),
      ),
    );
  }

  /** Records console messages and network requests of the prepared tabs until `stopDevtools()`. */
  async recordDevtools(): Promise<DevtoolsRecorder> {
    this.recorder = new DevtoolsRecorder();
    await Promise.all(
      [...this.sessions].map((id) => this.toggleDevtools(id, "enable")),
    );
    return this.recorder;
  }

  async stopDevtools() {
    this.recorder = undefined;
    await Promise.all(
      [...this.sessions].map((id) => this.toggleDevtools(id, "disable")),
    );
  }

  async close() {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      await this.cdp.send("Browser.close").catch(() => child.kill());
      await Promise.race([exited, sleep(5_000)]);
      child.kill();
    }
    this.cdp.close();
  }
}
