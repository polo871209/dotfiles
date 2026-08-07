// Customizes pi TUI: input text color, slim footer, strips a container
// margin artifact, renders the autocomplete dropdown as a floating overlay
// above the editor — the dropdown covers the conversation lines underneath
// instead of pushing the editor up or reserving a permanent gap.
import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  TuiAltScreen,
  TuiMainScreen,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// pi's own message containers render with a 1-column left margin (a real
// space character in the terminal grid, not screen padding), so selecting
// text out of the pane always drags that space along. Footer/divider lines
// span full width with no margin and are untouched since they don't start
// with one. Strip right after any leading ANSI color codes so colored lines
// still get the same trim. Also skip OSC sequences (e.g. the OSC 133 zone
// markers pi prepends to an assistant message's last line) — otherwise that
// line keeps its margin and shifts 1 column right while streaming.
const LEADING_MARGIN =
  /^((?:\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*) /;
const stripLeadingMargin = (lines: string[]): string[] =>
  lines.map((l) => l.replace(LEADING_MARGIN, "$1"));

// Patch render on both concrete screen classes (regular and fullscreen) to
// strip the leading margin from every rendered line. Re-installable across
// /reload the same way pi's own patches are: walk past wrapper layers from
// previous module loads to the true original before wrapping again.
const MARGIN_TAG = "__marginStripped";
const installMarginStripPatch = (klass: {
  prototype: { render(width: number): string[] };
}) => {
  const proto = klass.prototype as unknown as {
    render(width: number): string[];
  };
  let origRender = proto.render as unknown as {
    (width: number): string[];
    [MARGIN_TAG]?: { orig: (width: number) => string[] };
  };
  while (origRender[MARGIN_TAG]) {
    origRender = origRender[MARGIN_TAG].orig as typeof origRender;
  }
  const wrapper = function (this: typeof proto, width: number): string[] {
    return stripLeadingMargin(origRender.call(this, width));
  } as unknown as typeof origRender;
  wrapper[MARGIN_TAG] = { orig: origRender };
  proto.render = wrapper;
};

const SGR_RESET = "\x1b[0m";
// Matches only actual decoration lines (a solid horizontal rule, or a
// "↑ 3 more"-style scroll hint) so we don't skip coloring a real input line
// that happens to be all digits or a word overlapping those characters.
const BORDER =
  /^(?:\x1b\[[0-9;]*m)*(?:─+|[↑↓]\s*\d+\s*more)(?:\x1b\[[0-9;]*m)*$/;

const colorInputLine = (line: string, theme: PiTheme) => {
  if (BORDER.test(line)) return line;
  const input = theme.getFgAnsi("text");
  return `${input}${line.replaceAll(SGR_RESET, `${SGR_RESET}${input}`)}${SGR_RESET}`;
};

// Render the autocomplete dropdown as a floating overlay above the
// editor. The editor never reserves space for it, so the input box
// never shifts vertically. The overlay covers conversation lines
// underneath when open and the lines are restored when it closes.
// Slightly lighter than gruvbox dark bg (#282828) so the overlay block
// reads as a panel without harsh contrast.
const OVERLAY_BG = "\x1b[48;2;60;56;54m"; // #3c3836

const wrapWithBg = (line: string, width: number): string => {
  // Reapply bg after each inner reset so nested ANSI codes don't strip it.
  const re = line.replaceAll(SGR_RESET, `${SGR_RESET}${OVERLAY_BG}`);
  const filler = " ".repeat(Math.max(0, width - visibleWidth(line)));
  return `${OVERLAY_BG}${re}${filler}${SGR_RESET}`;
};

class DropdownOverlay implements Component {
  list: { render(width: number): string[] } | null = null;
  render(width: number): string[] {
    if (!this.list) return [];
    return this.list.render(width).map((line) => wrapWithBg(line, width));
  }
  invalidate() {}
}

interface EditorWithOverlay {
  autocompleteState?: unknown;
  autocompleteList?: { render(width: number): string[] };
  autocompleteMaxVisible?: number;
  focused?: boolean;
  tui: TUI;
  __overlay?: {
    handle: OverlayHandle | null;
    comp: DropdownOverlay;
    lastEditorHeight: number;
  };
}

const FOOTER_ROWS = 1; // pi's footer is one row tall

const syncOverlay = (editor: EditorWithOverlay, editorHeight: number) => {
  const tui = editor.tui;
  if (!tui) return;

  const state = editor.autocompleteState;
  const list = editor.autocompleteList;

  let s = editor.__overlay;
  if (!s) {
    s = { handle: null, comp: new DropdownOverlay(), lastEditorHeight: 0 };
    editor.__overlay = s;
  }

  if (state && list) {
    s.comp.list = list;
    if (!s.handle || s.lastEditorHeight !== editorHeight) {
      if (s.handle) s.handle.hide();
      const termWidth = tui.terminal.columns;
      const overlayMaxHeight = (editor.autocompleteMaxVisible ?? 5) + 1;
      const overlayCol = 0;
      const overlayWidth = termWidth;
      // Anchor bottom-left and lift by (footer + editor height) so the
      // overlay's bottom edge sits one row above the editor regardless
      // of how many items the list currently renders. TUI re-runs anchor
      // resolution on each render with the live overlay height.
      s.handle = tui.showOverlay(s.comp, {
        anchor: "bottom-left",
        offsetY: -(FOOTER_ROWS + editorHeight),
        col: overlayCol,
        width: overlayWidth,
        maxHeight: overlayMaxHeight,
        nonCapturing: true,
        // Only render while the editor holds focus. A selector (ctx.ui.select,
        // model/settings pickers) swaps the editor out of the tree and takes
        // focus, so editor.render stops firing and can't hide this overlay —
        // without this gate it lingers on top of the selector and blocks it.
        visible: () => editor.focused === true,
      });
      s.lastEditorHeight = editorHeight;
    }
  } else if (s.handle) {
    s.handle.hide();
    s.handle = null;
  }
};

const AC_TAG = "__acOverlay";
const installAutocompleteAbovePatch = () => {
  const proto = Editor.prototype as unknown as {
    render(width: number): string[];
    autocompleteState?: unknown;
    autocompleteList?: { render(width: number): string[] };
  };

  // Re-installable across /reload (same pattern as the bottom-pin patch):
  // unwrap to the true original, then wrap with this module's live closures.
  let origRender = proto.render as unknown as {
    (width: number): string[];
    [AC_TAG]?: { orig: (width: number) => string[] };
  };
  while (origRender[AC_TAG]) {
    origRender = origRender[AC_TAG].orig as typeof origRender;
  }

  const wrapper = function (this: typeof proto, width: number): string[] {
    // Always strip the inline dropdown from the editor's own render so
    // the editor occupies the same rows whether autocomplete is active
    // or not.
    const state = this.autocompleteState;
    const list = this.autocompleteList;
    let lines: string[];
    if (state && list) {
      this.autocompleteState = undefined;
      lines = origRender.call(this, width);
      this.autocompleteState = state;
    } else {
      lines = origRender.call(this, width);
    }

    // Defer overlay management out of the current render pass; calling
    // showOverlay/hideOverlay inside render would mutate TUI state mid-
    // composite.
    const self = this as unknown as EditorWithOverlay;
    const editorHeight = lines.length;
    queueMicrotask(() => syncOverlay(self, editorHeight));

    return lines;
  } as unknown as typeof origRender;
  wrapper[AC_TAG] = { orig: origRender };
  proto.render = wrapper;
};

class ThemedEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly getTheme: () => PiTheme,
  ) {
    super(tui, editorTheme, keybindings);
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    return super.render(width).map((line) => colorInputLine(line, theme));
  }
}

const installInputColor = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, editorTheme, keybindings) =>
        new ThemedEditor(tui, editorTheme, keybindings, () => ctx.ui.theme),
    );
  });
};

// Working loader: subtle pulse + elapsed time so a long turn is visibly
// alive and its age readable at a glance.
const installWorking = (pi: ExtensionAPI) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    const t = ctx.ui.theme;
    ctx.ui.setWorkingIndicator({
      frames: [
        t.fg("dim", "·"),
        t.fg("muted", "•"),
        t.fg("accent", "●"),
        t.fg("muted", "•"),
      ],
      intervalMs: 150,
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    stop();
    const started = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - started) / 1000);
      const elapsed =
        s < 60
          ? `${s}s`
          : `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
      ctx.ui.setWorkingMessage(`working · ${elapsed}`);
    };
    tick();
    timer = setInterval(tick, 1000);
    timer.unref?.();
  });

  pi.on("agent_end", async (_event, ctx) => {
    stop();
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", async () => stop());
};

// Tool outputs start collapsed; ctrl+o still expands on demand.
const installCollapsedTools = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setToolsExpanded(false);
  });
};

// e.g. 1000 -> "1.0k", 1000000 -> "1.0M".
const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
};

const installFooter = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        let pwd = process.cwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;

        const modelName = ctx.model?.id ?? "no-model";
        let thinkingText = "";
        let thinkingKey: string | null = null;
        if (ctx.model?.reasoning) {
          const lvl = String(pi.getThinkingLevel() ?? "off");
          thinkingText = lvl === "off" ? "thinking off" : lvl;
          const cap = lvl.charAt(0).toUpperCase() + lvl.slice(1);
          thinkingKey = `thinking${cap}`;
        }

        const usage = ctx.getContextUsage?.();
        const usageText =
          usage?.percent != null
            ? `${usage.percent.toFixed(1)}%/${formatTokenCount(usage.contextWindow)}`
            : "";

        // Subagent panes are narrow tmux slivers — the full footer wraps or
        // gets clipped, so show only usage/model/thinking there.
        if (process.env.PI_IS_SUBAGENT === "1") {
          const subLeft = [
            usageText,
            thinkingText ? `${modelName} • ${thinkingText}` : modelName,
          ]
            .filter(Boolean)
            .join("   ");
          return [theme.fg("dim", subLeft)];
        }

        // lark/gws statuses come from skill-toggle.ts via ctx.ui.setStatus,
        // exposed here through footerData.
        const statuses = footerData.getExtensionStatuses();
        const larkText = statuses.get("lark") ?? "";
        // Lark brand blue.
        const larkColored = larkText
          ? `\x1b[38;2;51;112;255m${larkText}\x1b[39m`
          : "";
        const gwsText = statuses.get("gws") ?? "";
        // Google brand blue.
        const gwsColored = gwsText
          ? `\x1b[38;2;66;133;244m${gwsText}\x1b[39m`
          : "";

        const leftPlain = [
          pwd,
          usageText,
          thinkingText ? `${modelName} • ${thinkingText}` : modelName,
          larkText,
          gwsText,
        ]
          .filter(Boolean)
          .join("   ");
        const modelColored = thinkingKey
          ? `${theme.fg("dim", `${modelName} • `)}${theme.fg(thinkingKey as never, thinkingText)}`
          : theme.fg("dim", modelName);
        const dimLeft =
          theme.fg("dim", `${pwd}   `) +
          (usageText ? theme.fg("dim", `${usageText}   `) : "") +
          modelColored +
          (larkColored ? `   ${larkColored}` : "") +
          (gwsColored ? `   ${gwsColored}` : "");

        const sessionName = ctx.sessionManager.getSessionName?.() ?? "";
        const rightPlain = sessionName;
        const rightColored = theme.fg("dim", sessionName);

        const lw = visibleWidth(leftPlain);
        const rw = visibleWidth(rightPlain);
        let line: string;
        if (lw + 2 + rw <= width) {
          line = dimLeft + " ".repeat(width - lw - rw) + rightColored;
        } else if (lw < width) {
          const avail = width - lw - 2;
          const truncR =
            avail > 0 ? truncateToWidth(rightPlain, avail, "") : "";
          const truncRw = visibleWidth(truncR);
          line =
            dimLeft +
            " ".repeat(Math.max(0, width - lw - truncRw)) +
            theme.fg("dim", truncR);
        } else {
          line = theme.fg("dim", truncateToWidth(leftPlain, width, "..."));
        }

        return [line];
      },
    }));
  });
};

installMarginStripPatch(TuiMainScreen);
installMarginStripPatch(TuiAltScreen);
installAutocompleteAbovePatch();

export default function (pi: ExtensionAPI) {
  installInputColor(pi);
  installFooter(pi);
  installWorking(pi);
  installCollapsedTools(pi);
}
