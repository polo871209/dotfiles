import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run } from "../shared/exec";

const SCRIPT = path.join(import.meta.dirname, "rex.lua");
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "nu"]);
const OUTPUT_LINES = 12;
const TRANSCRIPT_LINES = 80;
const NON_SGR_ESCAPE =
  /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
// Rex starts every terminal through /usr/bin/login, which always exits 0, so the wrapper writes the real status to a file.
const WITH_EXIT_FILE = '"$0" -lic "$1"; echo $? > "$2"';

export type StepStatus =
  | { state: "sent"; block: string; since: number }
  | { state: "running"; block: string; since: number; program: string }
  | { state: "finished"; block: string; took: number }
  | { state: "closed"; block: string }
  | {
      state: "inline";
      block?: string;
      since: number;
      output: string[];
      inPane: boolean;
    }
  | {
      state: "exited";
      took: number;
      code: number | undefined;
      output: string[];
      transcript: string;
    };

export type Exited = Extract<StepStatus, { state: "exited" }>;

export type SettledStatus = Extract<
  StepStatus,
  { state: "exited" } | { state: "finished" }
>;

type Target = {
  block_id: string;
  label?: string;
  sibling: boolean;
  program?: string;
  cwd?: string;
};

type SendResult =
  | { status: "pick" }
  | {
      status: "sent" | "busy" | "no_bracketed_paste";
      block_id: string;
      program?: string;
    };

type RunEvent =
  | { kind: "started"; block_id: string }
  | { kind: "screen"; lines: string[] | Record<string, never> }
  | { kind: "exited"; text: string };

type WatchEvent =
  | { kind: "process"; block_id: string; program?: string }
  | { kind: "pwd" | "closed"; block_id: string };

export class Pane {
  private target: string | undefined;
  private watcher: ChildProcess | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly statuses = new Map<string, StepStatus>();
  private readonly active = new Map<string, string>();
  private readonly runs = new Map<string, ChildProcess>();

  constructor(
    private readonly session: string,
    private readonly self: string,
    private readonly onChange: (key?: string) => void,
    private readonly onSettle: (key: string, status: SettledStatus) => void,
  ) {}

  restore(key: string, status: SettledStatus): void {
    this.statuses.set(key, status);
  }

  status(key: string): StepStatus | undefined {
    return this.statuses.get(key);
  }

  private async lua<T>(args: Record<string, unknown>): Promise<T> {
    const r = await run(
      "rex",
      [
        "do",
        "-s",
        this.session,
        SCRIPT,
        "--json",
        "--args",
        JSON.stringify({ self: this.self, ...args }),
      ],
      undefined,
      undefined,
      15_000,
    );
    if (r.code !== 0)
      throw new Error(`rex: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    return JSON.parse(r.stdout) as T;
  }

  async pick(ctx: ExtensionContext): Promise<string | undefined> {
    const { targets } = await this.lua<{ targets: Target[] }>({
      op: "targets",
    });
    const home = process.env.HOME ?? "";
    const labels = targets.map((t) =>
      [
        t.label || t.block_id.slice(-6),
        t.program,
        t.cwd?.replace(home, "~"),
        t.sibling ? "this tab" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    const NEW = "New pane beside pi";
    const choice = await ctx.ui.select("Send commands to", [...labels, NEW]);
    if (!choice) return undefined;
    this.target =
      choice === NEW ? "new" : targets[labels.indexOf(choice)]?.block_id;
    return this.target;
  }

  async send(ctx: ExtensionContext, key: string, code: string): Promise<void> {
    this.ensureWatcher();
    const request = (target: string | undefined) =>
      this.lua<SendResult>({ op: "send", target, text: code, cwd: ctx.cwd });
    let result = await request(this.target);
    if (result.status === "pick") {
      if (!(await this.pick(ctx))) return;
      result = await request(this.target);
      if (result.status === "pick") return;
    }
    this.target = result.block_id;
    if (result.status === "busy") {
      ctx.ui.notify(
        `The target pane runs ${result.program ?? "no program"}, so nothing was sent. Pick another pane with /send-target.`,
        "warning",
      );
      return;
    }
    if (result.status === "no_bracketed_paste") {
      ctx.ui.notify(
        `${result.program} in the target pane has bracketed paste off, so a multi-line send would run each line.`,
        "warning",
      );
      return;
    }
    this.active.set(result.block_id, key);
    this.statuses.set(key, {
      state: "sent",
      block: result.block_id,
      since: Date.now(),
    });
    this.onChange(key);
  }

  run(
    cwd: string,
    key: string,
    code: string,
    columns: number,
  ): Promise<Exited> {
    const exitFile = path.join(os.tmpdir(), `pi-runbook-${randomUUID()}`);
    const child = spawn(
      "rex",
      [
        "do",
        "-s",
        this.session,
        SCRIPT,
        "--args",
        JSON.stringify({
          op: "run",
          label: "runbook",
          cwd,
          columns,
          rows: 24,
          lines: OUTPUT_LINES,
          transcript: TRANSCRIPT_LINES,
          command: [
            "/bin/sh",
            "-c",
            WITH_EXIT_FILE,
            process.env.SHELL ?? "/bin/zsh",
            code,
            exitFile,
          ],
        }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const since = Date.now();
    let status: Extract<StepStatus, { state: "inline" }> = {
      state: "inline",
      since,
      output: [],
      inPane: false,
    };
    let transcript = "";
    let stderr = "";
    const update = (next: Partial<typeof status>) => {
      status = { ...status, ...next };
      this.statuses.set(key, status);
      this.onChange(key);
    };
    this.runs.set(key, child);
    update({});
    this.syncTicker();
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: RunEvent;
      try {
        event = JSON.parse(line) as RunEvent;
      } catch {
        return;
      }
      if (event.kind === "started") update({ block: event.block_id });
      else if (event.kind === "screen")
        update({
          output: Array.isArray(event.lines)
            ? event.lines.map((l) => l.replace(NON_SGR_ESCAPE, ""))
            : [],
        });
      else transcript = event.text;
    });
    return new Promise((resolve) => {
      child.on("close", async () => {
        this.runs.delete(key);
        const written = await readFile(exitFile, "utf8").catch(() => "");
        await rm(exitFile, { force: true });
        const exitCode = written.trim() === "" ? undefined : Number(written);
        const failedToStart =
          status.block === undefined && stderr.split("\n").find(Boolean);
        const exited: Exited = {
          state: "exited",
          took: Date.now() - since,
          code: exitCode,
          output: failedToStart ? [failedToStart] : status.output,
          transcript: failedToStart || transcript,
        };
        this.statuses.set(key, exited);
        this.onSettle(key, exited);
        this.syncTicker();
        this.onChange(key);
        resolve(exited);
      });
    });
  }

  private inlineBlock(key: string): string | undefined {
    const status = this.statuses.get(key);
    return status?.state === "inline" ? status.block : undefined;
  }

  async interrupt(key: string): Promise<void> {
    const block = this.inlineBlock(key);
    if (block) await this.lua({ op: "write", block_id: block, data: "\x03" });
  }

  async moveToPane(key: string): Promise<void> {
    const status = this.statuses.get(key);
    if (status?.state !== "inline" || !status.block || status.inPane) return;
    await this.lua({ op: "pop", block_id: status.block });
    this.statuses.set(key, { ...status, inPane: true });
    this.onChange(key);
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    const child = spawn(
      "rex",
      [
        "do",
        "-s",
        this.session,
        SCRIPT,
        "--args",
        JSON.stringify({ op: "watch" }),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.watcher = child;
    child.on("exit", () => {
      if (this.watcher === child) this.watcher = undefined;
    });
    child.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.apply(JSON.parse(line) as WatchEvent);
      } catch {}
    });
  }

  private apply(event: WatchEvent): void {
    const key = this.active.get(event.block_id);
    const current = key ? this.statuses.get(key) : undefined;
    if (!key || !current) {
      if (event.kind === "closed" && this.target === event.block_id)
        this.target = undefined;
      return;
    }
    const block = event.block_id;
    let next: StepStatus | undefined;
    if (event.kind === "closed") {
      next = { state: "closed", block };
      this.active.delete(block);
      if (this.target === block) this.target = undefined;
    } else if (event.kind === "pwd" && current.state === "sent") {
      next = { state: "finished", block, took: Date.now() - current.since };
    } else if (event.kind === "process" && event.program) {
      if (!SHELLS.has(event.program) && current.state !== "finished")
        next = {
          state: "running",
          block,
          since: current.state === "running" ? current.since : Date.now(),
          program: event.program,
        };
      else if (SHELLS.has(event.program) && current.state === "running")
        next = { state: "finished", block, took: Date.now() - current.since };
    }
    if (!next) return;
    this.statuses.set(key, next);
    if (next.state === "finished") this.onSettle(key, next);
    this.syncTicker();
    this.onChange(key);
  }

  private syncTicker(): void {
    const running = [...this.statuses.values()].some(
      (s) => s.state === "running" || s.state === "inline",
    );
    if (running && !this.ticker) {
      this.ticker = setInterval(this.onChange, 1000);
      this.ticker.unref?.();
    } else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  dispose(): void {
    for (const [key, child] of this.runs) {
      const status = this.statuses.get(key);
      if (status?.state === "inline" && status.block && !status.inPane)
        spawn(
          "rex",
          [
            "api",
            "call",
            "block.close",
            JSON.stringify({
              session_id: this.session,
              block_id: status.block,
            }),
          ],
          { stdio: "ignore", detached: true },
        ).unref();
      child.kill();
    }
    this.runs.clear();
    this.watcher?.kill();
    this.watcher = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
