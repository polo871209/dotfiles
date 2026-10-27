import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { LINK_OPEN, LINK_READY } from "../shared/link";
import { lastAssistantText, textMessages } from "../shared/message";
import {
  type Action,
  describeStatus,
  duration,
  failed,
  SELECTED_LINK,
  StepsCard,
} from "./card";
import { type Exited, Pane, type SettledStatus } from "./pane";
import {
  fenceSteps,
  type RunbookStep,
  runbookSteps,
  parseFences,
  type Step,
  textSteps,
} from "./steps";

const TOOL = "show_runbook";

const RunbookParams = Type.Object({
  steps: Type.Array(
    Type.Object({
      title: Type.String({ description: "What the step does, in a few words" }),
      command: Type.String({
        description:
          "The shell commands of this step, pasted at once into an interactive zsh. Start with cd when the directory matters.",
      }),
    }),
    { minItems: 1 },
  ),
});

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const ANSI = /\x1b\[[0-9;]*m/g;

const preview = (text: string, limit = 60): string => {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  const compact = (line ?? "(empty)").replace(/\s+/g, " ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
};

type BranchEntry = {
  type?: string;
  id: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
};
type ContentPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

const FAILED_ENTRY = "runbook-failed";
const RESULT_ENTRY = "runbook-result";
const ATTACH_ENTRY = "runbook-attach";
const REPORT_MESSAGE = "runbook-results";

type StepResult = { key: string; status: SettledStatus };
type LogAttach = { key: string; attach: boolean };
type ReportItem = {
  key: string;
  status: SettledStatus;
  withStatus: boolean;
  withLog: boolean;
};
type ReportDetails = {
  reported: string[];
  items: (ReportItem & { label: string })[];
};

const pendingReport = (
  ctx: ExtensionContext,
): { items: ReportItem[]; reported: string[] } => {
  const results = new Map<string, { id: string; status: SettledStatus }>();
  const attaches = new Map<string, { id: string; attach: boolean }>();
  const handedBack = new Set<string>();
  const reported = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
    if (entry.type === "custom_message" && entry.customType === REPORT_MESSAGE)
      for (const id of (entry.details as ReportDetails).reported)
        reported.add(id);
    if (entry.type !== "custom") continue;
    if (entry.customType === RESULT_ENTRY) {
      const { key, status } = entry.data as StepResult;
      results.set(key, { id: entry.id, status });
      attaches.delete(key);
      handedBack.delete(key);
    } else if (entry.customType === ATTACH_ENTRY) {
      const { key, attach } = entry.data as LogAttach;
      attaches.set(key, { id: entry.id, attach });
    } else if (entry.customType === FAILED_ENTRY)
      handedBack.add((entry.data as { key: string }).key);
  }
  const items: ReportItem[] = [];
  const ids: string[] = [];
  for (const [key, result] of results) {
    const attach = attaches.get(key);
    const wantsLog = attach?.attach === true && !reported.has(attach.id);
    if (wantsLog) ids.push(attach.id);
    const withStatus = !reported.has(result.id) && !handedBack.has(key);
    if (!reported.has(result.id)) ids.push(result.id);
    if (!withStatus && !wantsLog) continue;
    items.push({
      key,
      status: result.status,
      withStatus,
      withLog: wantsLog || (withStatus && failed(result.status)),
    });
  }
  return { items, reported: ids };
};

const outcome = (status: SettledStatus): string => {
  const took = duration(status.took);
  if (status.state === "finished")
    return `sent to a pane and finished after ${took}, exit code unknown`;
  if (status.code === undefined) return `ended after ${took} with no exit code`;
  if (status.code === 130) return `stopped by the user after ${took}`;
  return `exit ${status.code} in ${took}`;
};

type Card = { id?: string; steps: Step[] };
type Turn = { role?: string; cards: Card[] };
type Failure = {
  entryId: string;
  key: string;
  prompts: number;
  answered: boolean;
  fixId?: string;
};
type History = { turns: Turn[]; failure?: Failure };

const splice = (base: Step[], key: string, own: Step[]): Step[] => {
  const i = base.findIndex((step) => step.key === key);
  return i === -1 ? own : [...base.slice(0, i), ...own, ...base.slice(i + 1)];
};

const ownSteps = (toolCallId: string, args: unknown): Step[] =>
  runbookSteps(toolCallId, (args as { steps?: RunbookStep[] }).steps ?? []);

const waitingForFix = (failure: Failure | undefined): failure is Failure =>
  failure !== undefined && failure.prompts === 1 && !failure.fixId;

const history = (ctx: ExtensionContext): History => {
  const turns: Turn[] = [];
  let failure: Failure | undefined;
  const cardWith = (key: string): Step[] | undefined => {
    for (let t = turns.length - 1; t >= 0; t--)
      for (const card of turns[t].cards)
        if (card.steps.some((step) => step.key === key)) return card.steps;
  };
  for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
    if (entry.type === "custom" && entry.customType === FAILED_ENTRY) {
      const { key } = entry.data as { key: string };
      failure = { entryId: entry.id, key, prompts: 0, answered: false };
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "user" && failure && ++failure.prompts > 1)
      failure = undefined;
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      turns.push({ role: message.role, cards: [] });
      continue;
    }
    if (failure) failure.answered = true;
    const cards = (message.content as ContentPart[]).flatMap((part): Card[] => {
      if (part.type === "text") return [{ steps: textSteps(part.text) }];
      if (part.type !== "toolCall" || part.name !== TOOL) return [];
      const own = ownSteps(part.id, part.arguments);
      const base = waitingForFix(failure) ? cardWith(failure.key) : undefined;
      if (!base || !failure) return [{ id: part.id, steps: own }];
      failure.fixId = part.id;
      return [{ id: part.id, steps: splice(base, failure.key, own) }];
    });
    turns.push({ role: "assistant", cards });
  }
  return { turns: turns.reverse(), failure };
};

const latestCard = (ctx: ExtensionContext): Card => {
  for (const turn of history(ctx).turns) {
    if (turn.role === "user") break;
    const steps = turn.cards.flatMap((card) => card.steps);
    if (steps.length > 0)
      return {
        id: turn.cards.filter((card) => card.id).at(-1)?.id,
        steps,
      };
  }
  return { steps: [] };
};

const cardWithKey = (ctx: ExtensionContext, key: string): Card | undefined =>
  history(ctx)
    .turns.flatMap((turn) => turn.cards)
    .find((card) => card.steps.some((step) => step.key === key));

const formatSession = (
  ctx: ExtensionContext,
): { text: string; turns: number } => {
  const lines: string[] = [];
  const name = ctx.sessionManager.getSessionName();
  if (name) lines.push(`# ${name}`, "");
  const messages = textMessages(ctx.sessionManager.getBranch());
  for (const m of messages) lines.push(`## ${m.role}`, "", m.text, "");
  return { text: lines.join("\n").trimEnd() + "\n", turns: messages.length };
};

const copyWithNotify = async (
  ctx: ExtensionContext,
  value: string,
  label: string,
): Promise<void> => {
  try {
    await copyToClipboard(value);
    ctx.ui.notify(`Copied ${label} to clipboard`, "info");
  } catch (e) {
    ctx.ui.notify(errorText(e), "error");
  }
};

export default function (pi: ExtensionAPI) {
  const session = process.env.REX_SESSION;
  const self = process.env.REX_BLOCK;
  const invalidators = new Map<string, () => void>();
  const linked = new Map<string, Step>();
  let screen: TUI | undefined;
  const refresh = (key?: string) => {
    for (const invalidate of invalidators.values()) invalidate();
    const fenceChanged = key
      ? linked.has(key)
      : [...linked.keys()].some((k) => pane?.status(k)?.state === "inline");
    if (!fenceChanged || !screen) return;
    screen.invalidate();
    screen.requestRender();
  };
  const pane =
    session && self && process.env.PI_IS_SUBAGENT !== "1"
      ? new Pane(session, self, refresh, (key, status) =>
          pi.appendEntry<StepResult>(RESULT_ENTRY, { key, status }),
        )
      : undefined;
  let currentCtx: ExtensionContext | undefined;
  let selectedKey: string | undefined;
  let selectedCard: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    merged.clear();
    syncAttached(ctx);
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === RESULT_ENTRY) {
        const { key, status } = entry.data as StepResult;
        pane?.restore(key, status);
      }
    refresh();
  });
  pi.on("session_shutdown", async () => pane?.dispose());

  const merged = new Map<string, Step[]>();
  const resumed = new Set<string>();
  const attached = new Set<string>();

  const syncAttached = (ctx: ExtensionContext) => {
    attached.clear();
    for (const item of pendingReport(ctx).items)
      if (item.withLog && !failed(item.status)) attached.add(item.key);
  };

  const stepLabel = (ctx: ExtensionContext, key: string): string => {
    const steps = cardWithKey(ctx, key)?.steps ?? [];
    const index = steps.findIndex((step) => step.key === key);
    const step = steps[index];
    if (!step) return "A runbook step";
    return `Step ${index + 1} "${step.title ?? preview(step.code)}"`;
  };

  pi.on("before_agent_start", async (_event, ctx) => {
    const { items, reported } = pendingReport(ctx);
    if (items.length === 0) return;
    const labelled = items.map((item) => ({
      ...item,
      label: stepLabel(ctx, item.key),
    }));
    const lines = ["Runbook results since your last turn:"];
    for (const item of labelled) {
      lines.push(
        item.withStatus
          ? `- ${item.label}: ${outcome(item.status)}.`
          : `- ${item.label}: output the user attached.`,
      );
      if (item.withLog && item.status.state === "exited")
        lines.push(
          "```",
          item.status.transcript.replace(ANSI, "") || "(no output)",
          "```",
        );
    }
    attached.clear();
    refresh();
    return {
      message: {
        customType: REPORT_MESSAGE,
        content: lines.join("\n"),
        display: true,
        details: { reported, items: labelled } satisfies ReportDetails,
      },
    };
  });

  pi.registerMessageRenderer<ReportDetails>(
    REPORT_MESSAGE,
    (message, _options, theme) => {
      const items = message.details?.items ?? [];
      const rows = items.map((item) => {
        const chip = describeStatus(item.status);
        const status =
          item.withStatus && chip ? theme.fg(chip.color, chip.text) : "";
        const log = item.withLog ? theme.fg("dim", "· log sent") : "";
        return `  ${item.label}  ${[status, log].filter(Boolean).join(" ")}`;
      });
      return new Text(
        [
          theme.fg("accent", theme.bold("▍Runbook results sent to the agent")),
          ...rows,
        ].join("\n"),
        0,
        0,
      );
    },
  );

  const cardSteps = (toolCallId: string, own: Step[]): Step[] => {
    const cached = merged.get(toolCallId);
    if (cached || !currentCtx) return cached ?? own;
    const { turns, failure } = history(currentCtx);
    const done = turns
      .flatMap((turn) => turn.cards)
      .find((card) => card.id === toolCallId);
    if (done) {
      merged.set(toolCallId, done.steps);
      return done.steps;
    }
    const base = waitingForFix(failure)
      ? cardWithKey(currentCtx, failure.key)
      : undefined;
    return base && failure ? splice(base.steps, failure.key, own) : own;
  };

  pi.on("agent_end", async (_event, ctx) => {
    const { failure } = history(ctx);
    if (!failure?.answered || failure.prompts !== 1 || ctx.mode !== "tui")
      return;
    if (resumed.has(failure.entryId)) return;
    resumed.add(failure.entryId);
    const key = failure.fixId ? `${failure.fixId}:0` : failure.key;
    const card = cardWithKey(ctx, key);
    if (card) void browse(ctx, card, key);
  });

  const runInline = async (step: Step): Promise<Exited | undefined> => {
    const ctx = currentCtx;
    if (!ctx || !pane || pane.status(step.key)?.state === "inline") return;
    try {
      return await pane.run(
        ctx.cwd,
        step.key,
        step.code,
        Math.max(40, (process.stdout.columns ?? 100) - 10),
      );
    } catch (e) {
      ctx.ui.notify(errorText(e), "error");
    }
  };

  const askAgent = (ctx: ExtensionContext, step: Step) => {
    const status = pane?.status(step.key);
    if (status?.state !== "exited") return;
    const message = [
      `The runbook step "${step.title ?? preview(step.code)}" failed with exit ${status.code}. Find the cause and fix it. If the command itself is wrong, show only the fixed step with ${TOOL}, and it takes the place of the failed step.`,
      "",
      "```sh",
      step.code,
      "```",
      "",
      "Output:",
      "",
      "```",
      status.transcript.replace(ANSI, "") || "(no output)",
      "```",
    ].join("\n");
    pi.appendEntry(FAILED_ENTRY, { key: step.key });
    void pi.sendUserMessage(
      message,
      ctx.isIdle() ? undefined : { deliverAs: "followUp" },
    );
  };

  const act = async (step: Step, action: Action): Promise<boolean> => {
    const ctx = currentCtx;
    if (!ctx) return false;
    try {
      switch (action) {
        case "copy":
          await copyToClipboard(step.code);
          break;
        case "send":
          await copyToClipboard(step.code);
          await pane?.send(ctx, step.key, step.code);
          break;
        case "run":
          void runInline(step);
          break;
        case "stop":
          await pane?.interrupt(step.key);
          break;
        case "pop":
          await pane?.moveToPane(step.key);
          break;
        case "debug":
          askAgent(ctx, step);
          break;
        case "log": {
          const attach = !attached.has(step.key);
          pi.appendEntry<LogAttach>(ATTACH_ENTRY, { key: step.key, attach });
          if (attach) attached.add(step.key);
          else attached.delete(step.key);
          refresh(step.key);
          break;
        }
      }
      return true;
    } catch (e) {
      ctx.ui.notify(errorText(e), "error");
      return false;
    }
  };

  pi.registerTool({
    name: TOOL,
    label: "Runbook",
    description:
      "Hand shell commands to the user to run themselves, such as production writes or commands that need their credentials. The user sees each step with buttons to run it, send it to a terminal, or copy it, and can hand a failed step's output back to you. Call it as the last action of the turn, after the explanation. One step is one unit the user runs at once. To fix a step the user handed back, show only the fixed step, and it takes the failed step's place in the same runbook.",
    parameters: RunbookParams,
    exposure: "model-only",
    renderShell: "self",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    async execute(id, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui")
        return {
          content: [
            {
              type: "text",
              text: "This pi has no interactive UI, so the user did not see the steps. Write each step as its own sh fenced block instead.",
            },
          ],
          details: undefined,
          isError: true,
        };
      const steps = cardSteps(id, ownSteps(id, params));
      const fixed = steps.some((step) => !step.key.startsWith(`${id}:`));
      return {
        content: [
          {
            type: "text",
            text: fixed
              ? `The fixed step replaced the failed one. The user sees all ${steps.length} steps and continues from the fixed step.`
              : `The user sees ${steps.length} steps and runs them.`,
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
    renderCall(args, theme, context) {
      const card =
        context.lastComponent instanceof StepsCard
          ? context.lastComponent
          : new StepsCard({
              status: (key) => pane?.status(key),
              canSend: pane !== undefined,
              logAttached: (key) => attached.has(key),
              selected: () =>
                selectedCard === context.toolCallId ? selectedKey : undefined,
              act,
            });
      invalidators.set(context.toolCallId, context.invalidate);
      card.update(
        cardSteps(context.toolCallId, ownSteps(context.toolCallId, args)),
        context.argsComplete ||
          context.executionStarted ||
          merged.has(context.toolCallId),
        theme,
        context.invalidate,
      );
      return card;
    },
    renderResult: () => new Container(),
  });

  const reveal = (tui: TUI, step: Step, direction: 1 | -1) => {
    const screen = tui as unknown as {
      getScreenLines?: () => string[];
      scrollBy?: (lines: number) => void;
    };
    if (!screen.getScreenLines || !screen.scrollBy) return;
    const scrollBy = (lines: number) => screen.scrollBy?.(lines);
    const marker = `${SELECTED_LINK}${step.key}`;
    const editorAndFooterRows = 8;
    const height = step.code.split("\n").length + editorAndFooterRows;
    let tries = 0;
    const check = () => {
      if (selectedKey !== step.key) return;
      const lines = screen.getScreenLines?.() ?? [];
      const row = lines.findIndex((line) => line.includes(marker));
      if (row === -1) {
        if (++tries > 100) return;
        scrollBy(direction * 4);
      } else {
        const overflow = row + height - lines.length;
        if (row < 1) scrollBy(row - 1);
        else if (overflow > 0) scrollBy(Math.min(overflow, row - 1));
        else return;
        tries = 100;
      }
      tui.requestRender();
      setTimeout(check, 20);
    };
    setTimeout(check, 20);
  };

  const browse = async (
    ctx: ExtensionContext,
    card = latestCard(ctx),
    startKey?: string,
  ): Promise<void> => {
    const { steps } = card;
    if (steps.length === 0) {
      const text = lastAssistantText(ctx.sessionManager.getBranch());
      if (text) await copyWithNotify(ctx, text, "response");
      else ctx.ui.notify("No assistant messages yet", "warning");
      return;
    }
    if (ctx.mode !== "tui") {
      await copyWithNotify(ctx, steps[0].code, "code block");
      return;
    }
    let index = Math.max(
      0,
      steps.findIndex((s) =>
        startKey ? s.key === startKey : !pane?.status(s.key),
      ),
    );
    let note: { text: string; color: "success" | "warning" } | undefined;
    const select = (tui: TUI, next: number, direction: 1 | -1) => {
      index = next;
      note = undefined;
      selectedKey = steps[index].key;
      selectedCard = card.id;
      tui.invalidate();
      tui.requestRender();
      reveal(tui, steps[index], direction);
    };
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      screen = tui;
      select(tui, index, -1);
      const hints = (step: Step): string => {
        const status = pane?.status(step.key);
        if (status?.state === "inline")
          return status.inPane
            ? "ctrl+c stop · ↑↓ move · esc close"
            : "ctrl+c stop · o move to pane · ↑↓ move · esc close";
        if (!pane || !step.shell) return "⏎ copy · ↑↓ move · esc close";
        const run = status ? "R run again" : "i run inline";
        const fix = failed(status)
          ? "d ask agent to fix · "
          : status?.state === "exited"
            ? `l ${attached.has(step.key) ? "detach" : "attach"} log · `
            : "";
        return `${fix}${run} · s send to pane · ⏎ copy · ↑↓ move · esc close`;
      };
      return {
        render(width: number): string[] {
          const step = steps[index];
          return [
            ` ${theme.fg("accent", theme.bold(`Step ${index + 1}/${steps.length}`))}  ${preview(step.title ?? step.code)}${note ? `  ${theme.fg(note.color, note.text)}` : ""}`,
            theme.fg("dim", ` ${hints(step)}`),
          ].map((line) => truncateToWidth(line, width));
        },
        handleInput(data: string): void {
          const step = steps[index];
          const status = pane?.status(step.key);
          const next = () => {
            if (selectedKey !== step.key) return;
            const unrun = steps
              .map((candidate, i) => ({ candidate, i }))
              .filter(
                ({ candidate }) =>
                  candidate.shell && !pane?.status(candidate.key),
              );
            const target = unrun.find(({ i }) => i > index) ?? unrun.at(0);
            if (target) {
              select(tui, target.i, target.i > index ? 1 : -1);
              return;
            }
            const allPassed = steps.every((candidate) => {
              const result = pane?.status(candidate.key);
              return (
                !candidate.shell ||
                (result !== undefined &&
                  result.state !== "inline" &&
                  !failed(result))
              );
            });
            if (allPassed) done();
          };
          if (matchesKey(data, "ctrl+c") && status?.state === "inline")
            void act(step, "stop");
          else if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "q"
          )
            done();
          else if (keybindings.matches(data, "tui.select.up") || data === "k")
            select(tui, Math.max(0, index - 1), -1);
          else if (keybindings.matches(data, "tui.select.down") || data === "j")
            select(tui, Math.min(steps.length - 1, index + 1), 1);
          else if (/^[1-9]$/.test(data) && Number(data) <= steps.length)
            select(tui, Number(data) - 1, Number(data) - 1 > index ? 1 : -1);
          else if (keybindings.matches(data, "tui.select.confirm"))
            void act(step, "copy").then((ok) => {
              if (!ok) return;
              note = { text: "✓ copied", color: "success" };
              tui.requestRender();
            });
          else if (!pane || !step.shell) return;
          else if (data === "s")
            void act(step, "send").then((ok) => ok && next());
          else if (data === "i" && status) {
            note = { text: "already ran · R runs it again", color: "warning" };
            tui.requestRender();
          } else if (
            data === "i" ||
            data === "R" ||
            matchesKey(data, "shift+r")
          )
            void runInline(step).then((result) => result?.code === 0 && next());
          else if (data === "o") void act(step, "pop");
          else if (
            data === "l" &&
            status?.state === "exited" &&
            !failed(status)
          )
            void act(step, "log").then(() => tui.requestRender());
          else if (data === "d" && failed(status)) {
            done();
            askAgent(ctx, step);
          }
        },
        invalidate() {},
      };
    });
    selectedKey = selectedCard = undefined;
    screen?.invalidate();
    screen?.requestRender();
  };

  for (const name of ["copy-blocks", "run"])
    pi.registerCommand(name, {
      description:
        "Walk the code blocks and steps of the last response to run, send, or copy them",
      handler: async (_args, ctx) => browse(ctx),
    });
  pi.registerShortcut("ctrl+alt+c", {
    description:
      "Walk the code blocks and steps of the last response to run, send, or copy them",
    handler: (ctx) => browse(ctx),
  });

  pi.registerCommand("copy-all", {
    description: "Copy entire session history (user + assistant) as markdown",
    handler: async (_args, ctx) => {
      const { text, turns } = formatSession(ctx);
      if (turns === 0) {
        ctx.ui.notify("Session is empty", "warning");
        return;
      }
      await copyWithNotify(
        ctx,
        text,
        `session (${turns} turns, ${text.length} chars)`,
      );
    },
  });

  let linksReady = false;
  pi.events.on(LINK_READY, () => {
    linksReady = true;
  });
  pi.events.on(LINK_OPEN, (url) => {
    const match =
      typeof url === "string" &&
      /^pi-block:(copy|send|run|stop|pop|debug)\/(\w+)$/.exec(url);
    const ctx = currentCtx;
    if (!match || !ctx) return;
    const step = linked.get(match[2]);
    if (!step) {
      ctx.ui.notify("That code block is no longer on screen", "warning");
      return;
    }
    void act(step, match[1] as Action).then(
      (ok) =>
        ok && match[1] === "copy" && ctx.ui.notify("Copied code block", "info"),
    );
  });

  const links = (step: Step): string[] => {
    linked.set(step.key, step);
    const link = (label: string, action: Action) =>
      `[${label}](pi-block:${action}/${step.key})`;
    if (!step.shell || !pane) return [link("⧉ copy", "copy")];
    const status = pane.status(step.key);
    const buttons =
      status?.state === "inline"
        ? [link("■ stop", "stop"), link("⇱ move to pane", "pop")]
        : [
            ...(failed(status) ? [link("✦ ask agent to fix", "debug")] : []),
            link("▷ inline", "run"),
            link("▶ send", "send"),
            link("⧉ copy", "copy"),
          ];
    const chip = describeStatus(status);
    if (status?.state !== "inline" && status?.state !== "exited")
      return [[...buttons, ...(chip ? [`*${chip.text}*`] : [])].join(" · ")];
    return [
      [...buttons, `*${chip?.text}*`].join(" · "),
      "",
      "```",
      ...(status.output.length > 0
        ? status.output.map((line) => line.replace(ANSI, ""))
        : ["…"]),
      "```",
    ];
  };

  pi.registerMarkdownTransformer((markdown, context) => {
    if (
      !linksReady ||
      context.messageType !== "assistant" ||
      context.isStreaming
    )
      return markdown;
    const lines = markdown.split("\n");
    const fences = parseFences(lines).filter(
      (f) => f.closed && f.lang?.toLowerCase() !== "mermaid",
    );
    if (fences.length === 0) return markdown;
    const out: string[] = [];
    let cursor = 0;
    for (const fence of fences) {
      out.push(...lines.slice(cursor, fence.start));
      const pad = (line: string) => `${fence.indent}${line}`;
      fenceSteps(fence).forEach((step, i) => {
        if (i > 0) out.push("");
        if (step.key === selectedKey)
          out.push(pad(`[▶ selected](${SELECTED_LINK}${step.key})`), "");
        if (step.title)
          out.push(
            pad(step.title.replace(/^(\d+)([.)])|^([-+*>])/, "$1\\$2$3")),
          );
        out.push(
          pad(`${fence.marker}${fence.lang ?? ""}`),
          ...step.code.split("\n").map(pad),
          pad(fence.marker),
          ...links(step).map(pad),
        );
      });
      cursor = fence.end + 1;
      if (lines[cursor]?.trim()) out.push("");
    }
    out.push(...lines.slice(cursor));
    return out.join("\n");
  });

  if (!pane) return;

  pi.registerCommand("send-target", {
    description: "Choose the Rex pane that receives sent steps",
    handler: async (_args, ctx) => {
      try {
        await pane.pick(ctx);
      } catch (e) {
        ctx.ui.notify(errorText(e), "error");
      }
    },
  });

  pi.registerShortcut("ctrl+alt+s", {
    description: "Send the next shell step of the last response to a Rex pane",
    handler: async (ctx) => {
      const steps = latestCard(ctx).steps.filter((s) => s.shell);
      if (steps.length === 0) {
        ctx.ui.notify("The last response has no shell steps", "warning");
        return;
      }
      const sent = steps.map((s) => pane.status(s.key) !== undefined);
      const next = steps[sent.lastIndexOf(true) + 1];
      if (!next) {
        ctx.ui.notify(`All ${steps.length} steps were sent`, "info");
        return;
      }
      await act(next, "send");
    },
  });
}
