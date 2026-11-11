import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export interface Llm {
  model: string;
  key: string;
  oauth: boolean;
}

export interface Outcome {
  status: "done" | "blocked" | "error";
  reason?: string;
  result?: string;
  url: string;
  title: string;
}

type Event = { type: "step"; text: string } | ({ type: "result" } & Outcome);

interface Waiter {
  onStep: (text: string) => void;
  resolve: (outcome: Outcome) => void;
  reject: (error: Error) => void;
}

/** One browser-use 1.0 process (agent.py) attached to one Helium. Runs one request at a time. */
export class BrowserUse {
  private waiter: Waiter | undefined;
  private readonly stderr: string[] = [];
  private exited = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(line) as Event;
      if (event.type === "step") this.waiter?.onStep(event.text);
      else {
        const { type: _, ...outcome } = event;
        this.settle((waiter) => waiter.resolve(outcome));
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 20) this.stderr.shift();
    });
    const fail = (reason: string) => {
      this.exited = true;
      this.settle((waiter) =>
        waiter.reject(
          new Error(`browser-use ${reason}.\n${this.stderr.join("\n")}`),
        ),
      );
    };
    child.once("exit", (code, signal) =>
      fail(`exited with ${signal ?? `code ${code}`}`),
    );
    child.once("error", (error) => fail(`did not start: ${error.message}`));
  }

  /** `background` keeps the agent's tab out of sight, for the user's open Helium. */
  static async start(
    endpoint: string,
    background: boolean,
  ): Promise<BrowserUse> {
    const install = await promisify(execFile)("mise", [
      "where",
      "pipx:browser-use",
    ]).catch(() => {
      throw new Error(
        "browser-use is not installed. Run `mise install pipx:browser-use`.",
      );
    });
    return new BrowserUse(
      spawn(
        join(install.stdout.trim(), "browser-use/bin/python"),
        [
          join(import.meta.dirname, "agent.py"),
          endpoint,
          background ? "background" : "visible",
        ],
        { env: { ...process.env, ANONYMIZED_TELEMETRY: "false" } },
      ),
    );
  }

  get alive() {
    return !this.exited;
  }

  private settle(finish: (waiter: Waiter) => void) {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) finish(waiter);
  }

  /** Opens `url` in the agent's tab, then runs `goal` there. Aborting stops the process. */
  run(
    request: { url?: string; goal?: string; llm?: Llm },
    onStep: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<Outcome> {
    if (this.exited) throw new Error("browser-use is not running.");
    if (this.waiter) throw new Error("browser-use is busy.");
    return new Promise<Outcome>((resolve, reject) => {
      const abort = () => {
        this.settle((waiter) => waiter.reject(new Error("Cancelled.")));
        void this.close("SIGINT");
      };
      signal?.addEventListener("abort", abort, { once: true });
      const done = () => signal?.removeEventListener("abort", abort);
      this.waiter = {
        onStep,
        resolve: (outcome) => {
          done();
          resolve(outcome);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      };
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Ends the agent's tab and the process. The browser stays open. `SIGINT` also cancels a running task. */
  async close(signal?: "SIGINT") {
    if (this.exited) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    if (signal) this.child.kill(signal);
    if (await Promise.race([exited.then(() => true), sleep(15_000)])) return;
    this.child.kill("SIGKILL");
  }
}
