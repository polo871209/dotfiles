import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const ENTRY_TYPE = "tickets";

type Snapshot = { tickets: string[] };

function isSnapshot(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: Snapshot } {
  return (
    entry.type === "custom" &&
    entry.customType === ENTRY_TYPE &&
    Array.isArray((entry.data as Snapshot | undefined)?.tickets)
  );
}

// Snapshots are taken across all branches, so /tree navigation keeps the queue.
function restoreQueue(ctx: ExtensionContext): string[] {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (isSnapshot(entry)) return [...entry.data.tickets];
  }
  return [];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function preferNextCommand(
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const result = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      const typed = result?.prefix.trimStart() ?? "";
      const next = result?.items.find((item) => item.value === "next");
      if (!result || !next || typed.length < 2 || !"/next".startsWith(typed))
        return result;
      return {
        ...result,
        items: [next, ...result.items.filter((item) => item !== next)],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

class TicketPanel implements Component {
  cursor = 0;
  handle: OverlayHandle | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly queue: () => string[],
    private readonly actions: {
      move: (from: number, to: number) => void;
      remove: (index: number) => void;
      edit: (index: number) => Promise<void>;
    },
  ) {}

  managing = false;

  focus(): void {
    this.managing = true;
    this.handle?.focus();
    this.refresh();
  }

  blur(): void {
    this.managing = false;
    this.handle?.unfocus();
    this.refresh();
  }

  refresh(): void {
    this.cursor = Math.max(0, Math.min(this.cursor, this.queue().length - 1));
    this.tui.requestRender();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const count = this.queue().length;
    const at = this.cursor;
    if (matchesKey(data, "escape") || matchesKey(data, "q")) this.blur();
    else if (count === 0) return;
    else if (matchesKey(data, "shift+up") || matchesKey(data, "shift+k")) {
      if (at > 0) this.actions.move(at, (this.cursor = at - 1));
    } else if (matchesKey(data, "shift+down") || matchesKey(data, "shift+j")) {
      if (at < count - 1) this.actions.move(at, (this.cursor = at + 1));
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.cursor = Math.max(0, at - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.cursor = Math.min(count - 1, at + 1);
    } else if (matchesKey(data, "t")) {
      this.actions.move(at, (this.cursor = 0));
    } else if (matchesKey(data, "x") || matchesKey(data, "delete")) {
      this.actions.remove(at);
    } else if (matchesKey(data, "enter") || matchesKey(data, "e")) {
      void this.actions.edit(at);
    }
    this.refresh();
  }

  render(width: number): string[] {
    const th = this.theme;
    const tickets = this.queue();
    const focused = this.managing;
    const border = (s: string) => th.fg(focused ? "borderAccent" : "border", s);
    const inner = Math.max(1, width - 4);
    const row = (content: string) => {
      const fitted = truncateToWidth(content, inner);
      return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
    };

    const title = ` Tickets ${tickets.length} `;
    const lines = [
      border(
        `╭─${title}${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`,
      ),
    ];
    if (tickets.length === 0) lines.push(row(th.fg("dim", "empty")));
    tickets.forEach((ticket, i) => {
      const selected = focused && i === this.cursor;
      const label = `${i + 1}. ${oneLine(ticket)}`;
      lines.push(
        row(
          `${selected ? th.fg("accent", "›") : " "}${
            selected
              ? th.fg("accent", label)
              : th.fg(i === 0 ? "text" : "muted", label)
          }`,
        ),
      );
    });
    if (focused) {
      lines.push(row(th.fg("dim", "↑↓ select  ⇧↑↓ move  t top")));
      lines.push(row(th.fg("dim", "⏎ edit  x delete  esc close")));
    }
    lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    return lines;
  }
}

export default function tickets(pi: ExtensionAPI): void {
  let queue: string[] = [];
  let ui: ExtensionContext["ui"] | undefined;
  let panel: TicketPanel | undefined;
  let closePanel = () => {};
  let compacting = false;

  const changed = () => {
    pi.appendEntry<Snapshot>(ENTRY_TYPE, { tickets: [...queue] });
    ui?.setStatus(
      "tickets",
      queue.length ? `tickets ${queue.length}` : undefined,
    );
    panel?.refresh();
  };

  const add = (text: string) => {
    queue.push(text);
    changed();
    ui?.notify(`Ticket ${queue.length} queued`, "info");
  };

  // pi-tui returns focus to whatever held it when the overlay opened, so managing reopens it from the editor.
  const openPanel = (ctx: ExtensionContext, manage: boolean) => {
    if (ctx.mode !== "tui") return;
    closePanel();
    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const opened = new TicketPanel(tui, theme, () => queue, {
          move(from: number, to: number) {
            const [ticket] = queue.splice(from, 1);
            queue.splice(to, 0, ticket!);
            changed();
          },
          remove(index: number) {
            queue.splice(index, 1);
            changed();
          },
          async edit(index: number) {
            const before = queue[index];
            if (before === undefined || !ui) return;
            panel?.blur();
            const after = (
              await ui.editor(`Edit ticket ${index + 1}`, before)
            )?.trim();
            if (after && queue[index] === before) {
              queue[index] = after;
              changed();
            }
            panel?.focus();
          },
        });
        panel = opened;
        closePanel = () => {
          closePanel = () => {};
          done();
          if (panel === opened) panel = undefined;
        };
        return opened;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          width: 44,
          maxHeight: "60%",
          margin: { top: 1, right: 1 },
          nonCapturing: true,
          visible: (termWidth) =>
            (panel?.managing ?? false) ||
            (queue.length > 0 && termWidth >= 100),
        },
        onHandle: (handle) => {
          if (!panel) return;
          panel.handle = handle;
          if (manage) panel.focus();
        },
      },
    );
  };

  const next = async (ctx: ExtensionContext) => {
    if (compacting) {
      ctx.ui.notify("/next is compacting before it sends a ticket", "warning");
      return;
    }
    if (queue.length === 0) {
      ctx.ui.notify("No tickets queued", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      pi.sendUserMessage(queue.shift()!, { deliverAs: "followUp" });
      changed();
      return;
    }
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (tokens > 300_000) {
      ctx.ui.notify(
        `Context is ${Math.round(tokens / 1000)}k tokens. Compacting before the next ticket.`,
        "info",
      );
      compacting = true;
      try {
        await new Promise<void>((resolve, reject) =>
          ctx.compact({ onComplete: () => resolve(), onError: reject }),
        );
      } catch (error) {
        ctx.ui.notify(
          `Compaction failed, ticket kept in the queue: ${(error as Error).message}`,
          "error",
        );
        return;
      } finally {
        compacting = false;
      }
    }
    const ticket = queue.shift();
    if (ticket === undefined) return;
    changed();
    pi.sendUserMessage(ticket);
  };

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    queue = restoreQueue(ctx);
    ctx.ui.setStatus(
      "tickets",
      queue.length ? `tickets ${queue.length}` : undefined,
    );
    openPanel(ctx, false);
    if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider(preferNextCommand);
  });

  pi.on("session_shutdown", async () => {
    closePanel();
    ui = undefined;
  });

  pi.registerCommand("ticket", {
    description: "Queue a ticket for /next (no text opens an editor)",
    handler: async (args, ctx) => {
      const text =
        (args ?? "").trim() || (await ctx.ui.editor("New ticket"))?.trim();
      if (text) add(text);
    },
  });

  pi.registerCommand("next", {
    description:
      "Send the first ticket, or queue it as a follow-up while the agent works",
    handler: async (_args, ctx) => next(ctx),
  });

  const manage = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") {
      openPanel(ctx, true);
      return;
    }
    ctx.ui.notify(
      queue.map((t, i) => `${i + 1}. ${oneLine(t)}`).join("\n") ||
        "No tickets queued",
      "info",
    );
  };

  pi.registerCommand("tickets", {
    description: "Focus the ticket panel to reorder, edit, or delete tickets",
    handler: async (_args, ctx) => manage(ctx),
  });

  pi.registerShortcut("ctrl+alt+enter", {
    description:
      "Queue the editor text as a ticket, or manage tickets when the editor is empty",
    handler: (ctx) => {
      const text = ctx.ui.getEditorText().trim();
      if (!text) {
        manage(ctx);
        return;
      }
      ctx.ui.setEditorText("");
      add(text);
    },
  });
}
