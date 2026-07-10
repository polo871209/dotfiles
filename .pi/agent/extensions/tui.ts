// Customizes pi TUI: input text color, slim footer, pins the editor to the
// bottom of the viewport even when the conversation is short, renders the
// autocomplete dropdown as a floating overlay above the editor — the dropdown
// covers the conversation lines underneath instead of pushing the editor up or
// reserving a permanent gap — and enables mouse support: click a code block
// to copy it (block ids come from code-blocks.ts markers), wheel-up enters
// tmux copy-mode so scrollback keeps working.
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  TUI,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// Pi reloads extensions with moduleCache:false, so this module's top-level
// state is re-bound on /new while the prototype patch from the first load stays
// in place. Stash the editor reference on the TUI instance itself so the patch
// always reads the live binding, not a stale module-local variable.
const PINNED_EDITOR_KEY = "__piPinnedEditor";

const getPinnedEditor = (tui: TUI): Component | null =>
  (tui as unknown as Record<string, Component | null>)[PINNED_EDITOR_KEY] ??
  null;

const setPinnedEditor = (tui: TUI, editor: Component): void => {
  (tui as unknown as Record<string, Component | null>)[PINNED_EDITOR_KEY] =
    editor;
};

const containsComponent = (node: Component, target: Component): boolean => {
  if (node === target) return true;
  const kids = (node as unknown as { children?: Component[] }).children;
  if (!Array.isArray(kids)) return false;
  for (const k of kids) if (containsComponent(k, target)) return true;
  return false;
};

// pi's own message containers render with a 1-column left margin (a real
// space character in the terminal grid, not screen padding), so selecting
// text out of the pane always drags that space along. Footer/divider lines
// span full width with no margin and are untouched since they don't start
// with one. Strip right after any leading ANSI color codes so colored lines
// still get the same trim.
const LEADING_MARGIN = /^((?:\x1b\[[0-9;]*m)*) /;
const stripLeadingMargin = (lines: string[]): string[] =>
  lines.map((l) => l.replace(LEADING_MARGIN, "$1"));

// code-blocks.ts tags each code-block line with a zero-width APC marker
// carrying the block id. Harvest markers into a row -> block-id map (for
// click hit-testing) and strip them so they never reach the terminal — tmux
// would pass unknown APC sequences through and some terminals render junk.
const CB_MARKER = /\x1b_pi-cb:(\d+)\x07/;
const CB_MARKER_ALL = /\x1b_pi-cb:\d+\x07/g;
const CB_ROW_MAP_KEY = "__cbRowMap";

const harvestBlockMarkers = (tui: TUI, lines: string[]): string[] => {
  const map = new Map<number, number>();
  const out = lines.map((l, i) => {
    const m = CB_MARKER.exec(l);
    if (!m) return l;
    map.set(i, Number(m[1]));
    return l.replaceAll(CB_MARKER_ALL, "");
  });
  (tui as unknown as Record<string, unknown>)[CB_ROW_MAP_KEY] = map;
  return out;
};

// Patch TUI.render to split children at the editor and fill the gap above it
// with blank lines so the editor (and its bottom-anchored autocomplete overlay)
// sits at the bottom of the viewport even on a fresh session. As the
// conversation grows the filler shrinks to 0 and normal scrolling takes over.
const PIN_TAG = "__bottomPinned";
const installBottomPinPatch = () => {
  const proto = TUI.prototype as unknown as {
    render(width: number): string[];
    children: Component[];
    terminal: { rows: number; columns: number };
  };

  // Re-installable across /reload: walk past wrappers from previous module
  // loads to the true original, then install a fresh wrapper bound to this
  // module's live helpers (a stale wrapper would keep old closures alive and
  // miss features added since, e.g. code-block marker harvesting).
  let origRender = proto.render as unknown as {
    (width: number): string[];
    [PIN_TAG]?: { orig: (width: number) => string[] };
  };
  while (origRender[PIN_TAG]) {
    origRender = origRender[PIN_TAG].orig as typeof origRender;
  }
  const wrapper = function (this: typeof proto, width: number): string[] {
    const editor = getPinnedEditor(this as unknown as TUI);
    let editorIdx = -1;
    if (editor) {
      for (let i = 0; i < this.children.length; i++) {
        if (containsComponent(this.children[i], editor)) {
          editorIdx = i;
          break;
        }
      }
    }

    const finalize = (lines: string[]): string[] =>
      harvestBlockMarkers(this as unknown as TUI, stripLeadingMargin(lines));

    if (editorIdx <= 0) return finalize(origRender.call(this, width));

    const before: string[] = [];
    for (let i = 0; i < editorIdx; i++)
      before.push(...this.children[i].render(width));
    const rest: string[] = [];
    for (let i = editorIdx; i < this.children.length; i++)
      rest.push(...this.children[i].render(width));
    // Pad up to the bottom of the *current viewport*, not just terminal.rows:
    // when a tall transient UI (dialog, questionnaire) collapses, the frame
    // shrinks but the terminal viewport top stays put, so anchoring to rows
    // alone leaves the editor stranded mid-screen with blank rows below it.
    const viewportTop =
      (this as unknown as { previousViewportTop?: number })
        .previousViewportTop ?? 0;
    const filler = Math.max(
      0,
      viewportTop + this.terminal.rows - before.length - rest.length,
    );
    return finalize(
      filler > 0
        ? [...before, ...new Array<string>(filler).fill(""), ...rest]
        : [...before, ...rest],
    );
  } as unknown as typeof origRender;
  wrapper[PIN_TAG] = { orig: origRender };
  proto.render = wrapper;
};

// --- Mouse: click a code block to copy it -----------------------------------
// pi-tui never enables mouse reporting, so we request SGR mouse (1000 = click
// press/release, 1006 = SGR encoding) ourselves. tmux forwards events with
// pane-relative coordinates. Wheel-up hands control back to tmux copy-mode so
// scrollback still feels native; every mouse sequence is consumed so it never
// reaches the editor as junk input.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const MOUSE_LISTENER_KEY = "__cbMouseListener";

interface CodeBlockRegistry {
  byId: Map<number, string>;
}
const blockRegistry = (): CodeBlockRegistry | undefined =>
  (globalThis as Record<string, unknown>).__piCodeBlocks as
    CodeBlockRegistry | undefined;

const pbcopy = (text: string) => {
  const p = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] });
  // Swallow spawn/pipe failures (missing binary, EPIPE) — an unhandled
  // "error" event would crash pi over a failed copy.
  p.on("error", () => {});
  p.stdin.on("error", () => {});
  p.stdin.write(text);
  p.stdin.end();
};

let mouseCtx: ExtensionContext | undefined;

const installMouseListener = (tui: TUI) => {
  const t = tui as unknown as Record<string, unknown> & {
    addInputListener(
      l: (data: string) => { consume?: boolean } | undefined,
    ): () => void;
    previousViewportTop?: number;
  };
  // Re-register on /reload: drop the previous module's listener (its closure
  // holds a stale ctx) and install this module's fresh one.
  const prevUnsub = t[MOUSE_LISTENER_KEY];
  if (typeof prevUnsub === "function") (prevUnsub as () => void)();

  t[MOUSE_LISTENER_KEY] = t.addInputListener((data: string) => {
    const m = SGR_MOUSE.exec(data);
    if (!m) return undefined;
    const btn = Number(m[1]);
    const row = Number(m[3]);
    const press = m[4] === "M";

    if (btn === 64) {
      // Wheel up: let tmux take over scrolling for this pane.
      if (press && process.env.TMUX && process.env.TMUX_PANE) {
        spawn("tmux", ["copy-mode", "-e", "-t", process.env.TMUX_PANE], {
          stdio: "ignore",
        }).on("error", () => {});
      }
      return { consume: true };
    }

    if (btn === 0 && press) {
      const rowMap = t[CB_ROW_MAP_KEY] as Map<number, number> | undefined;
      const lineIdx = (t.previousViewportTop ?? 0) + row - 1;
      const id = rowMap?.get(lineIdx);
      const code = id !== undefined ? blockRegistry()?.byId.get(id) : undefined;
      if (code !== undefined) {
        pbcopy(code);
        mouseCtx?.ui.notify("code block copied", "info");
      }
    }
    return { consume: true };
  });
};

let exitHookInstalled = false;
const installMouse = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    mouseCtx = ctx;
    process.stdout.write(MOUSE_ON);
  });
  pi.on("session_shutdown", async () => {
    process.stdout.write(MOUSE_OFF);
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => process.stdout.write(MOUSE_OFF));
  }
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
    setPinnedEditor(tui, this);
    installMouseListener(tui);
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
          usage?.percent != null ? `${usage.percent.toFixed(1)}%` : "";

        const leftPlain = [
          pwd,
          usageText,
          thinkingText ? `${modelName} • ${thinkingText}` : modelName,
        ]
          .filter(Boolean)
          .join("   ");
        const modelColored = thinkingKey
          ? `${theme.fg("dim", `${modelName} • `)}${theme.fg(thinkingKey as never, thinkingText)}`
          : theme.fg("dim", modelName);
        const dimLeft =
          theme.fg("dim", `${pwd}   `) +
          (usageText ? theme.fg("dim", `${usageText}   `) : "") +
          modelColored;

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

installBottomPinPatch();
installAutocompleteAbovePatch();

export default function (pi: ExtensionAPI) {
  installInputColor(pi);
  installFooter(pi);
  installMouse(pi);
}
