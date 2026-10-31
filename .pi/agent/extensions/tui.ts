import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Marked,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { diagramKind, type MermaidArt, render, type Span } from "grok-mermaid";
import { LINK_OPEN, LINK_READY, PI_LINK_PREFIX } from "./shared/link";
import { WORKING_FRAME_MS, workingFrames } from "./shared/working-indicator";

const SGR_RESET = "\x1b[0m";

const colorInputLine = (line: string, theme: PiTheme) => {
  if (
    /^(?:\x1b\[[0-9;]*m)*(?:─+|[↑↓]\s*\d+\s*more)(?:\x1b\[[0-9;]*m)*$/.test(
      line,
    )
  )
    return line;
  const input = theme.getFgAnsi("text");
  return `${input}${line.replaceAll(SGR_RESET, `${SGR_RESET}${input}`)}${SGR_RESET}`;
};

const wrapWithBg = (line: string, width: number, bg: string): string => {
  return `${bg}${line.replaceAll(SGR_RESET, `${SGR_RESET}${bg}`)}${" ".repeat(Math.max(0, width - visibleWidth(line)))}${SGR_RESET}`;
};

// Structural view of pi-tui's SelectList. `renderItem` and
// `getPrimaryColumnWidth` are TS-private but plain methods at runtime. The
// overlay calls them to draw items like the stock dropdown while owning the
// scroll window.
interface SelectItemLike {
  value: string;
  label: string;
  description?: string;
}
interface SelectListLike {
  render(width: number): string[];
  filteredItems?: SelectItemLike[];
  selectedIndex?: number;
  maxVisible?: number;
  theme?: {
    scrollInfo(text: string): string;
    noMatch(text: string): string;
  };
  renderItem?(
    item: SelectItemLike,
    isSelected: boolean,
    width: number,
    descriptionSingleLine: string | undefined,
    primaryColumnWidth: number,
  ): string;
  getPrimaryColumnWidth?(): number;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  setSelectedIndex?(index: number): void;
  onSelect?: (item: SelectItemLike) => void;
}

interface EditorWithOverlay {
  autocompleteState?: unknown;
  autocompleteList?: SelectListLike;
  autocompleteMaxVisible?: number;
  focused?: boolean;
  tui: TUI;
  getTheme?: () => PiTheme;
  __overlay?: {
    handle: OverlayHandle | null;
    comp: DropdownOverlay;
    opts: OverlayOptions;
  };
}

const isAutocompleteOpen = (editor: EditorWithOverlay): boolean =>
  Boolean(editor.autocompleteState && editor.autocompleteList);

const normalizeToSingleLine = (text: string) =>
  text.replace(/[\r\n]+/g, " ").trim();

class DropdownOverlay implements Component {
  private viewport: { list: SelectListLike; top: number } | null = null;

  constructor(private readonly editor: EditorWithOverlay) {}

  render(width: number): string[] {
    if (!isAutocompleteOpen(this.editor)) return [];
    return this.renderList(
      this.editor.autocompleteList as SelectListLike,
      width,
    ).map((line) =>
      wrapWithBg(
        line,
        width,
        this.editor.getTheme?.().getBgAnsi("userMessageBg") ??
          "\x1b[48;2;60;56;54m",
      ),
    );
  }

  private renderList(list: SelectListLike, width: number): string[] {
    const items = list.filteredItems;
    const selected = list.selectedIndex;
    const maxVisible = list.maxVisible;
    if (
      !items ||
      selected === undefined ||
      maxVisible === undefined ||
      !list.theme ||
      typeof list.renderItem !== "function" ||
      typeof list.getPrimaryColumnWidth !== "function"
    ) {
      return list.render(width);
    }
    const count = items.length;
    if (count === 0) return [list.theme.noMatch("  No matching commands")];

    if (this.viewport?.list !== list) this.viewport = { list, top: 0 };
    let top = this.viewport.top;
    if (selected < top) top = selected;
    else if (selected >= top + maxVisible) top = selected - maxVisible + 1;
    top = Math.max(0, Math.min(top, count - maxVisible));
    this.viewport.top = top;
    const lines: string[] = [];
    for (let i = top; i < Math.min(top + maxVisible, count); i++) {
      const item = items[i];
      if (!item) continue;
      lines.push(
        list.renderItem(
          item,
          i === selected,
          width,
          item.description
            ? normalizeToSingleLine(item.description)
            : undefined,
          list.getPrimaryColumnWidth(),
        ),
      );
    }
    if (count > maxVisible) {
      lines.push(
        list.theme.scrollInfo(
          truncateToWidth(`  (${selected + 1}/${count})`, width - 2, ""),
        ),
      );
    }
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!isAutocompleteOpen(this.editor)) return undefined;
    const list = this.editor.autocompleteList as SelectListLike;
    if (event.type === "wheel") return list.handleMouse?.(event);
    if (event.button !== "left") return undefined;
    if (event.type !== "press" && event.type !== "click") return undefined;
    const index =
      (this.viewport?.list === list ? this.viewport.top : 0) + event.y;
    const item = list.filteredItems?.[index];
    if (!item || event.y >= (list.maxVisible ?? 0)) return { handled: true };
    list.setSelectedIndex?.(index);
    if (event.type === "click") list.onSelect?.(item);
    return { handled: true };
  }

  invalidate() {}
}

const syncOverlay = (editor: EditorWithOverlay, editorHeight: number) => {
  const tui = editor.tui;
  if (!tui) return;

  let s = editor.__overlay;
  if (!s) {
    s = {
      handle: null,
      comp: new DropdownOverlay(editor),
      opts: {
        anchor: "bottom-left",
        offsetY: 0,
        col: 0,
        width: "100%",
        maxHeight: 0,
        nonCapturing: true,
        visible: () => editor.focused === true && isAutocompleteOpen(editor),
      },
    };
    editor.__overlay = s;
  }

  s.opts.offsetY = -(1 + editorHeight);
  s.opts.maxHeight = (editor.autocompleteMaxVisible ?? 5) + 1;

  if (isAutocompleteOpen(editor)) {
    if (!s.handle) s.handle = tui.showOverlay(s.comp, s.opts);
  } else if (s.handle) {
    s.handle.hide();
    s.handle = null;
  }
};

const AC_TAG = "__acOverlay";
const removeLegacyPrototypePatch = () => {
  const proto = Editor.prototype as unknown as {
    render: { [AC_TAG]?: { orig: unknown } };
  };
  let render = proto.render;
  while (render[AC_TAG]) render = render[AC_TAG].orig as typeof render;
  proto.render = render;
};

type Paint = (text: string) => string;

const rgbFg =
  (rgb: string): Paint =>
  (text) =>
    `\x1b[38;2;${rgb}m${text}\x1b[39m`;

const STATUS_BADGES = [
  { key: "lark", paint: rgbFg("51;112;255"), tintsEditor: false },
  { key: "gws", paint: rgbFg("66;133;244"), tintsEditor: false },
  { key: "poteto", paint: rgbFg("177;212;228"), tintsEditor: true },
];

const editorTint = (statuses: ReadonlyMap<string, string>) =>
  STATUS_BADGES.find((b) => b.tintsEditor && statuses.get(b.key))?.paint;

class ThemedEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    readonly getTheme: () => PiTheme,
    tint: () => Paint | undefined,
  ) {
    super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
    let base = this.borderColor;
    // pi-tui declares borderColor as an instance field, and pi reassigns it on each thinking-level or bash-mode change.
    Object.defineProperty(this, "borderColor", {
      get: () =>
        this.getText().trimStart().startsWith("!") ? base : (tint() ?? base),
      set: (paint: Paint) => {
        base = paint;
      },
    });
  }

  render(width: number): string[] {
    if (process.env.PI_IS_SUBAGENT === "1") return [];
    // autocompleteState is private in pi-tui, hence the cast.
    const self = this as unknown as EditorWithOverlay;
    const state = self.autocompleteState;
    let lines: string[];
    if (state && self.autocompleteList) {
      self.autocompleteState = undefined;
      try {
        lines = super.render(width);
      } finally {
        self.autocompleteState = state;
      }
    } else {
      lines = super.render(width);
    }
    syncOverlay(self, lines.length);
    return lines.map((line) => colorInputLine(line, this.getTheme()));
  }
}

const LINK_ROUTER = Symbol.for("pi.linkRouter");

// Fullscreen pi-tui opens a clicked OSC 8 link through the TS-private
// `TuiAltScreen.openUrl`, which has no extension hook. The router survives
// /reload on the TUI object, so a reload swaps its emitter instead of
// wrapping openUrl twice.
interface LinkRouterHost {
  openUrl?: (url: string) => void;
  [LINK_ROUTER]?: { emit: (url: string) => void };
}

const installLinkRouter = (tui: TUI, pi: ExtensionAPI) => {
  const host = tui as unknown as LinkRouterHost;
  const openUrl = host.openUrl;
  if (typeof openUrl !== "function") return;
  const emit = (url: string) => pi.events.emit(LINK_OPEN, url);
  const router = host[LINK_ROUTER];
  if (router) {
    router.emit = emit;
  } else {
    const created = { emit };
    host[LINK_ROUTER] = created;
    host.openUrl = (url) =>
      url.startsWith(PI_LINK_PREFIX) ? created.emit(url) : openUrl(url);
  }
  pi.events.emit(LINK_READY, undefined);
};

const installEditor = (pi: ExtensionAPI, statuses: StatusSource) => {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      installLinkRouter(tui, pi);
      return new ThemedEditor(
        tui,
        editorTheme,
        keybindings,
        () => ctx.ui.theme,
        () => editorTint(statuses.read()),
      );
    });
  });
};

const installWorking = (pi: ExtensionAPI) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const applyIndicator = (ctx: ExtensionContext) => {
    ctx.ui.setWorkingIndicator({
      frames: workingFrames(ctx.ui.theme),
      intervalMs: WORKING_FRAME_MS,
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") applyIndicator(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || timer) return;
    applyIndicator(ctx);
    const started = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - started) / 1000);
      ctx.ui.setWorkingMessage(
        `working · ${
          s < 60
            ? `${s}s`
            : `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`
        }`,
      );
    };
    tick();
    timer = setInterval(tick, 1000);
    timer.unref?.();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stop();
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", async () => stop());
};

const installCollapsedTools = (pi: ExtensionAPI) => {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setToolsExpanded(false);
  });
};

const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
};

interface StatusSource {
  read: () => ReadonlyMap<string, string>;
}

const installFooter = (pi: ExtensionAPI, statuses: StatusSource) => {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((_tui, theme, footerData) => {
      statuses.read = () => footerData.getExtensionStatuses();
      return {
        invalidate() {},
        render(width: number): string[] {
          const modelName = ctx.model?.id ?? "no-model";
          const lvl = String(pi.getThinkingLevel() ?? "off");
          const thinkingText = lvl === "off" ? "thinking off" : lvl;
          const model = ctx.model?.reasoning
            ? {
                plain: `${modelName} • ${thinkingText}`,
                colored: `${theme.fg("dim", `${modelName} • `)}${theme.fg(
                  `thinking${lvl.charAt(0).toUpperCase() + lvl.slice(1)}` as never,
                  thinkingText,
                )}`,
              }
            : { plain: modelName, colored: theme.fg("dim", modelName) };
          const dim = (text: string) => ({
            plain: text,
            colored: theme.fg("dim", text),
          });

          let segments: { plain: string; colored: string }[];
          if (process.env.PI_IS_SUBAGENT === "1") {
            segments = [
              dim(ctx.sessionManager.getSessionName?.() ?? ""),
              model,
            ];
          } else {
            let pwd = ctx.cwd;
            const home = process.env.HOME || process.env.USERPROFILE;
            if (home && pwd.startsWith(home))
              pwd = `~${pwd.slice(home.length)}`;
            const branch = footerData.getGitBranch();
            const worktree = pwd.match(/^(.*)\/\.worktree\/([^/]+)(\/.*)?$/);
            if (worktree) {
              const [, root, slug, subdir = ""] = worktree;
              pwd = `${root}${subdir} (wt:${branch ?? slug})`;
            } else if (branch) pwd = `${pwd} (${branch})`;

            const usage = ctx.getContextUsage?.();
            const active = footerData.getExtensionStatuses();
            segments = [
              dim(pwd),
              dim(
                usage?.percent != null
                  ? `${usage.percent.toFixed(1)}%/${formatTokenCount(usage.contextWindow)}`
                  : "",
              ),
              model,
              ...STATUS_BADGES.flatMap(({ key, paint }) => {
                const text = active.get(key);
                return text ? [{ plain: text, colored: paint(text) }] : [];
              }),
            ];
          }

          const gap = process.env.PI_IS_SUBAGENT === "1" ? " " : "   ";
          const shown = segments.filter((segment) => segment.plain);
          const plain = shown.map((segment) => segment.plain).join(gap);
          return [
            visibleWidth(plain) <= width
              ? shown.map((segment) => segment.colored).join(gap)
              : theme.fg("dim", truncateToWidth(plain, width, "...")),
          ];
        },
      };
    });
  });
};

const MIN_LABEL_WIDTH = 6;

const shortenLabel = (label: string, max: number) => {
  const text = label.replace(/<br\s*\/?>/gi, " ").trim();
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

const PARTICIPANT = /^(\s*(?:participant|actor)\s+\S+\s+as\s+)(.+)$/;

const sequenceLabels = (src: string) =>
  src.split("\n").flatMap((line) => {
    const participant = PARTICIPANT.exec(line);
    if (participant) return [participant[2]];
    const colon = line.indexOf(":");
    return colon === -1 ? [] : [line.slice(colon + 1)];
  });

const shortenSequence = (src: string, max: number) =>
  src
    .split("\n")
    .map((line) => {
      const participant = PARTICIPANT.exec(line);
      if (participant)
        return `${participant[1]}${shortenLabel(participant[2], max)}`;
      const colon = line.indexOf(":");
      return colon === -1
        ? line
        : `${line.slice(0, colon)}: ${shortenLabel(line.slice(colon + 1), max)}`;
    })
    .join("\n");

const fitMermaid = (src: string, width: number): MermaidArt | undefined => {
  const fitting = (candidate: string) => {
    const art = render(candidate);
    return art && art.width <= width ? art : undefined;
  };
  const kind = diagramKind(src);
  if (kind === "flowchart")
    return fitting(
      src.replace(/^(\s*(?:flowchart|graph)\s+)(?:LR|RL)\b/m, "$1TD"),
    );
  if (kind !== "sequence") return undefined;
  let best: MermaidArt | undefined;
  let low = MIN_LABEL_WIDTH;
  let high = Math.max(...sequenceLabels(src).map((l) => [...l].length));
  while (low <= high) {
    const max = Math.floor((low + high) / 2);
    const art = fitting(shortenSequence(src, max));
    if (art) {
      best = art;
      low = max + 1;
    } else {
      high = max - 1;
    }
  }
  return best;
};

const codeSpan = (line: string) => {
  const content = line || "\u00a0";
  const fence = "`".repeat(
    Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length)) + 1,
  );
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
};

const styleSpan = (span: Span, theme: PiTheme) => {
  switch (span.cls) {
    case "border":
      return theme.fg("borderMuted", span.text);
    case "text":
      return theme.fg("text", span.text);
    case "edge":
      return theme.fg("accent", span.text);
    case "edgeLabel":
      return theme.fg("muted", span.text);
    case "title":
      return theme.fg("accent", theme.bold(span.text));
    case "none":
      return span.text;
  }
};

// Pi's built-in Mermaid transformer leaves a diagram wider than the terminal as source, so redraw it narrower.
const installWideMermaid = (pi: ExtensionAPI) => {
  const parser = new Marked();
  let theme: PiTheme | undefined;
  let mode = "off";

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    theme = ctx.ui.theme;
    mode = SettingsManager.create(ctx.cwd).getMermaidRenderingMode();
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (
      !theme ||
      mode === "off" ||
      context.messageType === "assistant-thinking" ||
      (context.isStreaming && mode !== "streaming")
    )
      return markdown;
    const activeTheme = theme;
    return parser
      .lexer(markdown)
      .map((token) => {
        if (
          token.type !== "code" ||
          token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() !== "mermaid"
        )
          return token.raw;
        const art = render(token.text);
        if (
          !art ||
          art.width <= context.availableWidth ||
          (!context.isStreaming && art.warnings.length > 0)
        )
          return token.raw;
        const fitted = fitMermaid(token.text, context.availableWidth);
        if (!fitted) return token.raw;
        return `${fitted.styled
          .map((row) =>
            codeSpan(row.map((span) => styleSpan(span, activeTheme)).join("")),
          )
          .join("  \n")}\n`;
      })
      .join("");
  });
};

removeLegacyPrototypePatch();

export default function (pi: ExtensionAPI) {
  installWideMermaid(pi);
  const statuses: StatusSource = { read: () => new Map() };
  installEditor(pi, statuses);
  installFooter(pi, statuses);
  installWorking(pi);
  installCollapsedTools(pi);
}
