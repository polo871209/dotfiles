import {
  highlightCode,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  hyperlink,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { StepStatus } from "./pane";
import type { Step } from "./steps";

export type Action = "copy" | "send" | "run" | "stop" | "pop" | "debug" | "log";

export type CardHost = {
  status: (key: string) => StepStatus | undefined;
  canSend: boolean;
  selected: () => string | undefined;
  logAttached: (key: string) => boolean;
  act: (step: Step, action: Action) => Promise<boolean>;
};

type Hit = { y: number; x0: number; x1: number; step: Step; action: Action };

const SGR_RESET = "\x1b[0m";
const SPINNER = ["◐", "◓", "◑", "◒"];
const INDENT = "     ";

export const SELECTED_LINK = "pi-block:sel/";

const INTERRUPTED = 130;

const KEYS: Record<Action, string> = {
  run: "i",
  send: "s",
  copy: "⏎",
  stop: "ctrl+c",
  pop: "o",
  debug: "d",
  log: "l",
};

const FILLS: Record<Action, ThemeColor> = {
  run: "success",
  send: "accent",
  copy: "muted",
  stop: "warning",
  pop: "toolTitle",
  debug: "error",
  log: "mdLinkUrl",
};

// Theme.bg only takes the fixed ThemeBg slots, so a fill reuses a foreground color as background.
const asBackground = (fgAnsi: string): string => fgAnsi.replace("[38;", "[48;");
const asForeground = (bgAnsi: string): string => bgAnsi.replace("[48;", "[38;");

export const failed = (status: StepStatus | undefined): boolean =>
  status?.state === "exited" &&
  status.code !== undefined &&
  status.code !== 0 &&
  status.code !== INTERRUPTED;

export const duration = (ms: number): string => {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

const spinning = (since: number, label: string): string => {
  const elapsed = Date.now() - since;
  const frame = SPINNER[Math.floor(elapsed / 1000) % SPINNER.length];
  return `${frame} ${label} · ${duration(elapsed)}`;
};

export const describeStatus = (
  status: StepStatus | undefined,
): { color: ThemeColor; text: string } | undefined => {
  switch (status?.state) {
    case undefined:
      return undefined;
    case "sent":
      return { color: "warning", text: "● pasted · press Enter in the pane" };
    case "running":
      return { color: "accent", text: spinning(status.since, status.program) };
    case "finished":
      return { color: "muted", text: `■ finished · ${duration(status.took)}` };
    case "closed":
      return { color: "dim", text: "pane closed" };
    case "inline":
      return {
        color: "accent",
        text: spinning(
          status.since,
          status.inPane ? "running in pane" : "running",
        ),
      };
    case "exited": {
      const took = duration(status.took);
      if (status.code === 0)
        return { color: "success", text: `✓ exit 0 · ${took}` };
      if (status.code === INTERRUPTED)
        return { color: "warning", text: `■ stopped · ${took}` };
      if (status.code === undefined)
        return { color: "muted", text: `■ ended · ${took}` };
      return { color: "error", text: `✗ exit ${status.code} · ${took}` };
    }
  }
};

const spread = (left: string, right: string, width: number): string => {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2
    ? `${left}${" ".repeat(gap)}${right}`
    : truncateToWidth(left, width, "…");
};

export class StepsCard implements Component {
  private steps: Step[] = [];
  private ready = false;
  private theme: Theme | undefined;
  private requestRender: () => void = () => {};
  private hits: Hit[] = [];
  private pressed: Hit | undefined;
  private readonly copied = new Set<string>();

  constructor(private readonly host: CardHost) {}

  update(
    steps: Step[],
    ready: boolean,
    theme: Theme,
    requestRender: () => void,
  ): void {
    this.steps = steps;
    this.ready = ready;
    this.theme = theme;
    this.requestRender = requestRender;
  }

  render(width: number): string[] {
    const t = this.theme;
    if (!t) return [];
    const fit = (line: string) => truncateToWidth(line, width, "");
    const lines: string[] = [];
    this.hits = [];

    const { steps } = this;
    const count = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
    lines.push(
      fit(
        spread(
          t.fg("accent", t.bold("▍Run these yourself")),
          t.fg(
            "dim",
            this.host.canSend
              ? `${count} · ctrl+alt+c to use the keyboard`
              : count,
          ),
          width,
        ),
      ),
    );

    steps.forEach((step, i) => {
      const selected = this.host.selected() === step.key;
      const number = String(i + 1).padStart(2);
      const badge = selected
        ? hyperlink(
            t.inverse(t.fg("accent", t.bold(`▶${number} `))),
            `${SELECTED_LINK}${step.key}`,
          )
        : ` ${t.fg("accent", t.bold(number))} `;
      const title = step.title ?? "Step";
      lines.push("");
      lines.push(
        fit(
          spread(
            `${badge} ${selected ? t.fg("accent", t.bold(title)) : t.bold(title)}`,
            this.statusChip(t, this.host.status(step.key)),
            width,
          ),
        ),
      );

      const inner = Math.max(12, width - INDENT.length - 1);
      const bg = t.getBgAnsi("selectedBg");
      for (const raw of highlightCode(step.code, step.lang ?? "bash"))
        for (const segment of wrapTextWithAnsi(raw, inner - 2)) {
          const body = ` ${segment}`;
          const padded = `${body}${" ".repeat(Math.max(0, inner - visibleWidth(body)))}`;
          lines.push(
            fit(
              `${selected ? t.fg("accent", "   ▌ ") : INDENT}${bg}${padded.replaceAll(SGR_RESET, `${SGR_RESET}${bg}`)}${SGR_RESET}`,
            ),
          );
        }

      const status = this.host.status(step.key);
      if (status?.state === "inline" || status?.state === "exited") {
        const rail = selected ? t.fg("accent", "   ▌ ") : INDENT;
        const output =
          status.output.length > 0
            ? status.output
            : [
                t.fg(
                  "dim",
                  status.state === "inline"
                    ? "waiting for output…"
                    : "no output",
                ),
              ];
        for (const line of output)
          lines.push(
            fit(
              `${rail}${t.fg("dim", "│")} ${truncateToWidth(line, inner - 2, "")}${SGR_RESET}`,
            ),
          );
      }

      const y = lines.length;
      let x = INDENT.length;
      let row = INDENT;
      for (const action of this.actions(step)) {
        const key = selected
          ? `  ${action === "run" && this.host.status(step.key) ? "R" : KEYS[action]}`
          : "";
        const text = ` ${this.label(step, action)}${key} `;
        const w = visibleWidth(text);
        if (this.ready) this.hits.push({ y, x0: x, x1: x + w, step, action });
        row += `${this.button(t, step, action, text)}  `;
        x += w + 2;
      }
      lines.push(fit(row));
    });
    return lines;
  }

  private actions(step: Step): Action[] {
    if (!this.host.canSend || !step.shell) return ["copy"];
    const status = this.host.status(step.key);
    if (status?.state === "inline")
      return status.inPane ? ["stop", "copy"] : ["stop", "pop", "copy"];
    if (failed(status)) return ["debug", "run", "send", "copy"];
    if (status?.state === "exited") return ["log", "run", "send", "copy"];
    return ["run", "send", "copy"];
  }

  private label(step: Step, action: Action): string {
    const status = this.host.status(step.key);
    switch (action) {
      case "copy":
        return this.copied.has(step.key) ? "✓ Copied" : "⧉ Copy";
      case "run":
        return status ? "↻ Run again" : "▷ Run inline";
      case "send":
        return status && status.state !== "exited"
          ? "↻ Send again"
          : "▶ Send to pane";
      case "stop":
        return "■ Stop";
      case "pop":
        return "⇱ Move to pane";
      case "debug":
        return "✦ Ask agent to fix";
      case "log":
        return this.host.logAttached(step.key)
          ? "✓ Log attached"
          : "⊕ Attach log";
    }
  }

  private button(t: Theme, step: Step, action: Action, text: string): string {
    if (!this.ready) return t.fg("dim", text);
    const pressed =
      this.pressed?.step.key === step.key && this.pressed.action === action;
    const fill = asBackground(t.getFgAnsi(pressed ? "text" : FILLS[action]));
    const ink = asForeground(t.getBgAnsi("selectedBg"));
    return `${fill}${ink}${t.bold(text)}\x1b[39;49m`;
  }

  private statusChip(t: Theme, status: StepStatus | undefined): string {
    const chip = describeStatus(status);
    return chip ? t.fg(chip.color, chip.text) : "";
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "release") {
      const wasPressed = this.pressed !== undefined;
      this.pressed = undefined;
      return wasPressed ? { handled: true, render: true } : undefined;
    }
    if (event.button !== "left") return undefined;
    const hit = this.hits.find(
      (h) => h.y === event.y && event.x >= h.x0 && event.x < h.x1,
    );
    if (!hit) return undefined;
    if (event.type === "press") {
      this.pressed = hit;
      return { handled: true };
    }
    if (event.type === "click") {
      this.pressed = undefined;
      void this.trigger(hit);
      return { handled: true };
    }
    return undefined;
  }

  private async trigger(hit: Hit): Promise<void> {
    if (!(await this.host.act(hit.step, hit.action))) return;
    if (hit.action !== "copy") return;
    this.copied.add(hit.step.key);
    this.requestRender();
    setTimeout(() => {
      this.copied.delete(hit.step.key);
      this.requestRender();
    }, 1500).unref?.();
  }

  invalidate(): void {}
}
