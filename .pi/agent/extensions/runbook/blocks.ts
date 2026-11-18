import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run } from "../shared/exec";
import { rexDoArgs } from "../shared/rex";

const SCRIPT = path.join(import.meta.dirname, "rex.lua");
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "nu"]);
const OUTPUT_LINES = 12;
const TRANSCRIPT_LINES = 80;
const NON_SGR_ESCAPE =
  /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
// Rex starts every terminal through /usr/bin/login, which always exits 0, so the wrapper writes the real status to a file.
const WITH_EXIT_FILE = '"$0" -lic "$1"; echo $? > "$2"';

const shellWord = (text: string): string =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

export const inFolder = (cwd: string, code: string): string =>
  `cd ${shellWord(cwd)} && ${code}`;

export type Placement = "detached" | "floating" | "placed";

export type StepStatus =
  | { state: "sent"; block: string; since: number }
  | { state: "running"; block: string; since: number; program: string }
  | { state: "finished"; block: string; took: number; stopped?: boolean }
  | { state: "closed"; block: string }
  | {
      state: "inline";
      block?: string;
      since: number;
      output: string[];
      placement: Placement;
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

export class Blocks {
  private target: string | undefined;
  private watcher: ChildProcess | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly statuses = new Map<string, StepStatus>();
  private readonly active = new Map<string, string>();
  private readonly runs = new Map<string, ChildProcess>();
  private readonly shellReturns = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly inputs = new Map<string, WriteStream>();
  private disposed = false;

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
      rexDoArgs(
        SCRIPT,
        { self: this.self, ...args },
        { session: this.session, json: true },
      ),
      undefined,
      undefined,
      15_000,
    );
    if (r.code !== 0)
      throw new Error(`rex: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    return JSON.parse(r.stdout) as T;
  }

  async pick(
    ctx: ExtensionContext,
    title = "Send commands to",
  ): Promise<string | undefined> {
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
    const NEW = "New block beside pi";
    const choice = await ctx.ui.select(title, [...labels, NEW]);
    if (!choice) return undefined;
    this.target =
      choice === NEW ? "new" : targets[labels.indexOf(choice)]?.block_id;
    return this.target;
  }

  async send(ctx: ExtensionContext, key: string, code: string): Promise<void> {
    this.ensureWatcher();
    const request = (target: string | undefined) =>
      this.lua<SendResult>({
        op: "send",
        target,
        text: code,
        cwd: ctx.cwd,
        text_in_folder: inFolder(ctx.cwd, code),
      });
    let result = await request(this.target);
    if (result.status === "pick" || result.status === "busy") {
      const title =
        result.status === "busy"
          ? `The target block runs ${result.program ?? "no program"}. Send commands to`
          : undefined;
      if (!(await this.pick(ctx, title))) return;
      result = await request(this.target);
      if (result.status === "pick") return;
    }
    if (result.status === "busy") {
      ctx.ui.notify(
        `The target block runs ${result.program ?? "no program"}, so nothing was sent. Pick another block with /send-target.`,
        "warning",
      );
      return;
    }
    this.target = result.block_id;
    if (result.status === "no_bracketed_paste") {
      ctx.ui.notify(
        `${result.program} in the target block has bracketed paste off, so a multi-line send would run each line.`,
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
    const inputFifo = `${exitFile}.in`;
    execFileSync("mkfifo", [inputFifo]);
    const input = createWriteStream(inputFifo, { flags: "r+" });
    input.on("error", () => {});
    this.inputs.set(key, input);
    const child = spawn(
      "rex",
      rexDoArgs(
        SCRIPT,
        {
          op: "run",
          self: this.self,
          label: "runbook",
          cwd,
          columns,
          rows: 24,
          lines: OUTPUT_LINES,
          transcript: TRANSCRIPT_LINES,
          input: inputFifo,
          command: [
            "/bin/sh",
            "-c",
            WITH_EXIT_FILE,
            process.env.SHELL ?? "/bin/zsh",
            code,
            exitFile,
          ],
        },
        { session: this.session },
      ),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const since = Date.now();
    let status: Extract<StepStatus, { state: "inline" }> = {
      state: "inline",
      since,
      output: [],
      placement: "detached",
    };
    let transcript = "";
    let stderr = "";
    const update = (next: Partial<typeof status>) => {
      const current = this.statuses.get(key);
      status = { ...(current?.state === "inline" ? current : status), ...next };
      this.statuses.set(key, status);
      this.onChange(key);
    };
    child.on("error", (e) => (stderr += e.message));
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
        this.inputs.delete(key);
        input.destroy();
        const written = await readFile(exitFile, "utf8").catch(() => "");
        await rm(exitFile, { force: true });
        await rm(inputFifo, { force: true });
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
        if (this.disposed) return resolve(exited);
        this.statuses.set(key, exited);
        this.onSettle(key, exited);
        this.syncTicker();
        this.onChange(key);
        resolve(exited);
      });
    });
  }

  write(key: string, data: string): Promise<void> {
    const input = this.inputs.get(key);
    if (!input) return Promise.resolve();
    return new Promise((resolve, reject) =>
      input.write(data, (e) => (e ? reject(e) : resolve())),
    );
  }

  interrupt(key: string): Promise<void> {
    return this.write(key, "\x03");
  }

  float(key: string): Promise<void> {
    return this.movePlacement(key, "floating");
  }

  place(key: string): Promise<void> {
    return this.movePlacement(key, "placed");
  }

  private async movePlacement(key: string, to: Placement): Promise<void> {
    const status = this.statuses.get(key);
    if (status?.state !== "inline" || !status.block) return;
    if (status.placement === to || status.placement === "placed") return;
    await this.lua({
      op: to === "floating" ? "float" : "place",
      block_id: status.block,
    });
    const current = this.statuses.get(key);
    if (current?.state !== "inline") return;
    this.statuses.set(key, { ...current, placement: to });
    this.onChange(key);
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    const child = spawn(
      "rex",
      rexDoArgs(SCRIPT, { op: "watch" }, { session: this.session }),
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
    const shellInFront =
      event.kind === "process" && SHELLS.has(event.program ?? "");
    if (!shellInFront) {
      clearTimeout(this.shellReturns.get(block));
      this.shellReturns.delete(block);
    }
    if (event.kind === "closed") {
      this.active.delete(block);
      if (this.target === block) this.target = undefined;
      this.transition(key, { state: "closed", block });
    } else if (event.kind === "pwd" && current.state === "sent") {
      const took = Date.now() - current.since;
      this.transition(key, { state: "finished", block, took });
    } else if (event.kind !== "process" || !event.program) {
      return;
    } else if (!shellInFront && current.state !== "finished") {
      this.transition(key, {
        state: "running",
        block,
        since: current.state === "running" ? current.since : Date.now(),
        program: event.program,
      });
    } else if (
      shellInFront &&
      current.state === "running" &&
      !this.shellReturns.has(block)
    ) {
      // A shell loop brings the shell to the front between its commands, so only a shell that stays in front ends the step.
      const took = Date.now() - current.since;
      const timer = setTimeout(async () => {
        const stopped = await this.interrupted(block);
        if (this.shellReturns.get(block) !== timer) return;
        this.shellReturns.delete(block);
        if (this.statuses.get(key)?.state === "running")
          this.transition(key, { state: "finished", block, took, stopped });
      }, 1500);
      timer.unref?.();
      this.shellReturns.set(block, timer);
    }
  }

  // A command typed into a shell reports no exit status, but the terminal echoes ^C when the user interrupts it.
  private async interrupted(block: string): Promise<boolean> {
    const { lines } = await this.lua<{ lines: string[] }>({
      op: "last_lines",
      block_id: block,
      count: 3,
    }).catch(() => ({ lines: [] }));
    return lines.some((line) => line.includes("^C"));
  }

  private transition(key: string, next: StepStatus): void {
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
    this.disposed = true;
    for (const [key, child] of this.runs) {
      const status = this.statuses.get(key);
      if (
        status?.state === "inline" &&
        status.block &&
        status.placement !== "placed"
      )
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
        )
          .on("error", () => {})
          .unref();
      child.kill();
    }
    this.runs.clear();
    for (const input of this.inputs.values()) input.destroy();
    this.inputs.clear();
    for (const timer of this.shellReturns.values()) clearTimeout(timer);
    this.shellReturns.clear();
    this.watcher?.kill();
    this.watcher = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
