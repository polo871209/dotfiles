// Customizes pi TUI: input text color, slim footer, pins the editor to the
// bottom of the viewport even when the conversation is short, and renders the
// autocomplete dropdown as a floating overlay above the editor — the dropdown
// covers the conversation lines underneath instead of pushing the editor up or
// reserving a permanent gap.
import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
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

// Patch TUI.render to split children at the editor and fill the gap above it
// with blank lines so the editor (and its bottom-anchored autocomplete overlay)
// sits at the bottom of the viewport even on a fresh session. As the
// conversation grows the filler shrinks to 0 and normal scrolling takes over.
const installBottomPinPatch = () => {
  const proto = TUI.prototype as unknown as {
    render(width: number): string[];
    children: Component[];
    terminal: { rows: number; columns: number };
    __bottomPinned?: boolean;
  };

  if (proto.__bottomPinned) return;
  proto.__bottomPinned = true;
  const origRender = proto.render;
  proto.render = function (width: number): string[] {
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

    if (editorIdx <= 0) return origRender.call(this, width);

    const before: string[] = [];
    for (let i = 0; i < editorIdx; i++)
      before.push(...this.children[i].render(width));
    const rest: string[] = [];
    for (let i = editorIdx; i < this.children.length; i++)
      rest.push(...this.children[i].render(width));
    const filler = Math.max(
      0,
      this.terminal.rows - before.length - rest.length,
    );
    return filler > 0
      ? [...before, ...new Array<string>(filler).fill(""), ...rest]
      : [...before, ...rest];
  };
};

const RESET = "\x1b[0m";
const BORDER = /^(?:\x1b\[[0-9;]*m)*[─ ↑↓0-9more]+(?:\x1b\[[0-9;]*m)*$/;

const colorInputLine = (line: string, theme: PiTheme) => {
  if (BORDER.test(line)) return line;
  const input = theme.getFgAnsi("text");
  return `${input}${line.replaceAll(RESET, `${RESET}${input}`)}${RESET}`;
};

// Render the autocomplete dropdown as a floating overlay above the
// editor. The editor never reserves space for it, so the input box
// never shifts vertically. The overlay covers conversation lines
// underneath when open and the lines are restored when it closes.
// Slightly lighter than gruvbox dark bg (#282828) so the overlay block
// reads as a panel without harsh contrast.
const OVERLAY_BG = "\x1b[48;2;60;56;54m"; // #3c3836
const SGR_RESET = "\x1b[0m";

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

const installAutocompleteAbovePatch = () => {
  const proto = Editor.prototype as unknown as {
    render(width: number): string[];
    __acOverlay?: boolean;
    autocompleteState?: unknown;
    autocompleteList?: { render(width: number): string[] };
  };

  if (proto.__acOverlay) return;
  proto.__acOverlay = true;
  const origRender = proto.render;

  proto.render = function (width: number): string[] {
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
  };
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
}
