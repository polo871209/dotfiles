import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  type Color,
  colorToHex,
  colorToOkhsl,
  colorToOklch,
  colorToRgb,
  type Component,
  getCapabilities,
  getCellDimensions,
  mixColors,
  okhslColor,
  parseColor,
  renderImage,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Canvas, type Point, type Rgb } from "./raster";
import {
  formatTime,
  formatValue,
  type Ticks,
  timeTicks,
  valueTicks,
} from "./scale";
import {
  type ChartSpec,
  checkSpec,
  pointCount,
  seriesStats,
  xAt,
} from "./spec";

const PALETTE_TOKENS = [
  "accent",
  "success",
  "warning",
  "error",
  "syntaxFunction",
  "syntaxNumber",
  "syntaxOperator",
  "mdLinkUrl",
  "syntaxType",
  "borderMuted",
  "customMessageLabel",
  "syntaxString",
] as const;

const BRAILLE_DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SGR_MOUSE = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

function seriesColors(spec: ChartSpec, theme: Theme): Color[] {
  const background = colorToOklch(theme.colors.toolSuccessBg);
  const palette: Color[] = [];
  const seen = new Set<string>();
  for (const token of PALETTE_TOKENS) {
    const color = theme.colors[token];
    const hex = colorToHex(color);
    if (seen.has(hex)) continue;
    seen.add(hex);
    if (Math.abs(colorToOklch(color).l - background.l) >= 0.25)
      palette.push(color);
  }
  const base = colorToOkhsl(palette[0] ?? theme.colors.accent);
  for (let i = 1; palette.length < spec.series.length; i++)
    palette.push(okhslColor((base.h + i * 137.508) % 360, base.s, base.l));
  let next = 0;
  return spec.series.map((s) => {
    if (s.color?.startsWith("#")) return parseColor(s.color);
    if (s.color && s.color in theme.colors)
      return theme.colors[s.color as keyof typeof theme.colors];
    return palette[next++]!;
  });
}

/** Pixels per cell to draw at. Terminals that report cells under 24 px tall report logical points, so drawing at 2x keeps Retina displays sharp. */
function pixelCell(): { widthPx: number; heightPx: number } {
  const cell = getCellDimensions();
  const scale = cell.heightPx < 24 ? 2 : 1;
  return { widthPx: cell.widthPx * scale, heightPx: cell.heightPx * scale };
}

const countOf = (spec: ChartSpec): number =>
  pointCount(spec.x) ?? Math.max(...spec.series.map((s) => s.values.length));

const spacingOf = (spec: ChartSpec): number => {
  const count = countOf(spec);
  return count > 1
    ? (xAt(spec.x, count - 1) - xAt(spec.x, 0)) / (count - 1)
    : 1;
};

type Window = [number, number];

type Plot = { lines: string[]; axis: string };

type XYFrame = {
  rows: number;
  rowsPerTick: number;
  gutter: number;
  plotCols: number;
  y: Ticks;
  x: Ticks;
  domain: Window;
  first: number;
  last: number;
};

type Layout = { width: number; frame?: XYFrame; base?: Canvas; plot: Plot };

type Drag = {
  mode: "zoom" | "pan";
  anchor: number;
  col: number;
  window: Window;
};

export type ChartViewOptions = {
  expanded: boolean;
  showImages: boolean;
  /** Redraw after a change outside a mouse event, such as reloaded data. */
  requestRender?: () => void;
  /** Data for another x window. Without it, zoom and pan stay inside the loaded points. */
  reload?: (window: Window, signal: AbortSignal) => Promise<ChartSpec>;
};

/** pi reports no event when the pointer leaves a component, so the hovered view learns it from the next mouse report it does not receive. */
const pointer = { reports: 0, hovered: undefined as ChartView | undefined };

/** Clears hover details once the pointer leaves the chart. Pass pi's terminal input subscription. Returns the unsubscribe function. */
export function trackPointerLeave(
  onTerminalInput: (handler: (data: string) => undefined) => () => void,
): () => void {
  return onTerminalInput((data) => {
    if (!SGR_MOUSE.test(data) || !pointer.hovered) return undefined;
    const report = ++pointer.reports;
    setImmediate(() => {
      const view = pointer.hovered;
      if (view && report === pointer.reports && view.seenReport !== report)
        view.pointerLeft();
    });
    return undefined;
  });
}

/** A chart for a pi TUI render slot: pixels through pi's image protocol, braille without one, axes and legend as theme-colored text. In fullscreen mode the pointer shows values, a drag on the plot zooms, and a drag or scroll on the x axis pans or zooms. */
export class ChartView implements Component {
  private readonly imageId = allocateImageId();
  private data: ChartSpec;
  private window?: Window;
  private pointer?: { col: number; row: number };
  private drag?: Drag;
  private reloading?: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  };
  private status?: { text: string; error: boolean };
  private layout?: Layout;
  private lines?: readonly string[];
  seenReport = 0;

  constructor(
    private spec: ChartSpec,
    private theme: Theme,
    private options: ChartViewOptions,
  ) {
    this.data = spec;
  }

  update(spec: ChartSpec, theme: Theme, options: ChartViewOptions): void {
    const changed =
      spec !== this.spec ||
      theme !== this.theme ||
      options.expanded !== this.options.expanded ||
      options.showImages !== this.options.showImages;
    if (spec !== this.spec) {
      this.cancelReload();
      this.data = spec;
      this.window = undefined;
    }
    this.spec = spec;
    this.theme = theme;
    this.options = options;
    if (changed) this.invalidate();
  }

  invalidate(): void {
    this.layout = undefined;
    this.lines = undefined;
  }

  render(width: number): readonly string[] {
    if (this.layout?.width !== width) {
      this.layout = this.buildLayout(width);
      this.lines = undefined;
    }
    this.lines ??= this.compose(width, this.layout);
    return this.lines;
  }

  pointerLeft(): void {
    if (pointer.hovered === this) pointer.hovered = undefined;
    if (!this.pointer || this.drag) return;
    this.pointer = undefined;
    this.lines = undefined;
    this.options.requestRender?.();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    this.seenReport = pointer.reports;
    const frame = this.layout?.frame;
    if (!frame) return undefined;
    const col = event.x - frame.gutter;
    const inPlot =
      event.y >= 0 && event.y < frame.rows && col >= 0 && col < frame.plotCols;
    const onAxis = event.y === frame.rows && col >= 0 && col < frame.plotCols;
    const clamped = Math.min(frame.plotCols - 1, Math.max(0, col));
    const modified = event.shift || event.alt || event.ctrl;

    switch (event.type) {
      case "move":
        return this.setPointer(inPlot ? { col, row: event.y } : undefined);
      case "press":
        if (!(inPlot || onAxis) || event.button !== "left") return undefined;
        this.drag = {
          mode: onAxis || modified ? "pan" : "zoom",
          anchor: col,
          col,
          window: frame.domain,
        };
        this.lines = undefined;
        return { capture: true };
      case "drag": {
        const drag = this.drag;
        if (!drag) return undefined;
        drag.col = drag.mode === "pan" ? col : clamped;
        this.pointer = { col: clamped, row: event.y };
        if (drag.mode === "pan") {
          const span = drag.window[1] - drag.window[0];
          const shift = ((drag.anchor - col) / frame.plotCols) * span;
          this.setWindow(
            [drag.window[0] + shift, drag.window[1] + shift],
            false,
          );
        }
        this.lines = undefined;
        return { handled: true };
      }
      case "release": {
        const drag = this.drag;
        if (!drag) return undefined;
        this.drag = undefined;
        this.lines = undefined;
        if (drag.mode === "pan" && drag.col !== drag.anchor)
          this.setWindow(this.window ?? frame.domain, true);
        const [from, to] = [drag.anchor, drag.col].sort((a, b) => a - b);
        if (drag.mode === "zoom" && to! - from! >= 2)
          this.setWindow(
            [this.xFromCol(frame, from!), this.xFromCol(frame, to! + 1)],
            true,
          );
        return { handled: true, render: true };
      }
      case "click":
        if (event.clickCount !== 2 || !this.window) return { handled: true };
        this.resetWindow();
        return { handled: true, render: true };
      case "wheel": {
        if (!(onAxis || (inPlot && modified)) || !event.wheelDelta) {
          this.pointerLeft();
          return undefined;
        }
        const factor = Math.min(5, Math.max(0.2, 1.25 ** event.wheelDelta));
        const at = this.xFromCol(frame, col + 0.5);
        const [d0, d1] = frame.domain;
        this.setWindow(
          [at - (at - d0) * factor, at + (d1 - at) * factor],
          true,
        );
        return { handled: true, render: true };
      }
    }
  }

  private setPointer(
    next: { col: number; row: number } | undefined,
  ): TuiMouseEventResult | undefined {
    if (next) pointer.hovered = this;
    if (next?.col === this.pointer?.col && next?.row === this.pointer?.row)
      return undefined;
    this.pointer = next;
    this.lines = undefined;
    return { render: true };
  }

  private setWindow(window: Window, reload: boolean): void {
    const full = this.fullDomain(this.spec);
    const canReload = Boolean(this.options.reload);
    const minSpan = spacingOf(this.spec) * (canReload ? 0.05 : 2);
    let [a, b] = window;
    if (b - a < minSpan) {
      const mid = (a + b) / 2;
      [a, b] = [mid - minSpan / 2, mid + minSpan / 2];
    }
    if (!canReload) {
      const span = Math.min(b - a, full[1] - full[0]);
      a = Math.min(full[1] - span, Math.max(full[0], a));
      b = a + span;
    }
    const whole = a <= full[0] && b >= full[1] && !canReload;
    this.window = whole ? undefined : [a, b];
    this.layout = undefined;
    this.lines = undefined;
    if (reload && canReload) this.scheduleReload();
  }

  private resetWindow(): void {
    this.cancelReload();
    this.window = undefined;
    this.data = this.spec;
    this.status = undefined;
    this.layout = undefined;
    this.lines = undefined;
  }

  private cancelReload(): void {
    if (!this.reloading) return;
    clearTimeout(this.reloading.timer);
    this.reloading.controller.abort();
    this.reloading = undefined;
  }

  private scheduleReload(): void {
    const reload = this.options.reload;
    const window = this.window;
    if (!reload || !window) return;
    this.cancelReload();
    const controller = new AbortController();
    const done = (status?: { text: string; error: boolean }) => {
      if (controller.signal.aborted) return;
      this.reloading = undefined;
      this.status = status;
      this.invalidate();
      this.options.requestRender?.();
    };
    const timer = setTimeout(() => {
      this.status = { text: "loading…", error: false };
      this.lines = undefined;
      this.options.requestRender?.();
      reload(window, controller.signal).then(
        (spec) => {
          if (controller.signal.aborted) return;
          checkSpec(spec);
          this.data = spec;
          done();
        },
        (error: unknown) =>
          done({
            text: error instanceof Error ? error.message : String(error),
            error: true,
          }),
      );
    }, 150);
    this.reloading = { controller, timer };
  }

  private get usePixels(): boolean {
    return Boolean(getCapabilities().images && this.options.showImages);
  }

  private colors(): Color[] {
    const initial = seriesColors(this.spec, this.theme);
    const byName = new Map(
      this.spec.series.map((s, i) => [s.name, initial[i]!]),
    );
    const fallback = seriesColors(this.data, this.theme);
    return this.data.series.map((s, i) => byName.get(s.name) ?? fallback[i]!);
  }

  private buildLayout(width: number): Layout {
    const empty = { width, plot: { lines: [], axis: "" } };
    if (width < 30) return empty;
    if (this.data.x.type === "category")
      return { width, plot: this.barPlot(width) };
    const frame = this.xyFrame(width);
    if (!frame) return empty;
    const axis = this.axisRow(
      width,
      frame.gutter,
      frame.plotCols,
      frame.x,
      frame.domain,
    );
    if (this.usePixels)
      return {
        width,
        frame,
        base: this.xyCanvas(frame),
        plot: { lines: [], axis },
      };
    return { width, frame, plot: { lines: this.xyBraille(frame), axis } };
  }

  private compose(width: number, layout: Layout): string[] {
    const { frame, base, plot } = layout;
    const lines =
      frame && base
        ? (this.pixelLines(frame, base) ?? this.xyBraille(frame))
        : plot.lines;
    const axis = frame ? this.pointerAxis(frame, width) : undefined;
    return [
      ...lines,
      ...(plot.axis ? [axis ?? truncateToWidth(plot.axis, width)] : []),
      ...this.legend(width, frame),
      ...this.statusLine(width, frame),
    ];
  }

  private xLabel(x: number): string {
    if (this.data.x.type !== "time") return formatValue(x);
    const resolution = "step" in this.data.x ? this.data.x.step : 60;
    return formatTime(x, resolution);
  }

  private xFromCol(frame: XYFrame, col: number): number {
    const [d0, d1] = frame.domain;
    return d0 + (col / frame.plotCols) * (d1 - d0);
  }

  private countBelow(x: number, inclusive: boolean): number {
    const spec = this.data;
    const count = countOf(spec);
    if ("start" in spec.x) {
      const steps = (x - spec.x.start) / spec.x.step;
      const below = inclusive
        ? Math.floor(steps + 1e-9) + 1
        : Math.ceil(steps - 1e-9);
      return Math.min(count, Math.max(0, below));
    }
    const values = "values" in spec.x ? spec.x.values : [];
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inclusive ? values[mid]! <= x : values[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private hoverIndex(frame: XYFrame): number | undefined {
    if (!this.pointer || this.drag?.mode === "pan") return undefined;
    if (frame.first > frame.last) return undefined;
    const target = this.xFromCol(frame, this.pointer.col + 0.5);
    const after = Math.min(
      frame.last,
      Math.max(frame.first, this.countBelow(target, false)),
    );
    const before = Math.max(frame.first, after - 1);
    return Math.abs(xAt(this.data.x, before) - target) <
      Math.abs(xAt(this.data.x, after) - target)
      ? before
      : after;
  }

  private nearestSeries(frame: XYFrame, index: number): number | undefined {
    if (!this.pointer) return undefined;
    let best: number | undefined;
    let bestDistance = Infinity;
    this.data.series.forEach((s, i) => {
      const v = s.values[index];
      if (v === null || v === undefined) return;
      const distance = Math.abs(
        this.yOf(frame, v, 1) - (this.pointer!.row + 0.5),
      );
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  }

  private fullDomain(spec: ChartSpec): Window {
    const count = countOf(spec);
    const first = xAt(spec.x, 0);
    const last = xAt(spec.x, count - 1);
    const spacing = spacingOf(spec);
    const pad =
      (spec.kind ?? "line") === "bar"
        ? spacing / 2
        : first === last
          ? spacing
          : 0;
    return [first - pad, last + pad];
  }

  private valueRange(first: number, last: number): Window {
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.data.series)
      for (let i = Math.max(0, first); i <= last; i++) {
        const v = s.values[i];
        if (v === null || v === undefined) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    if (min > max) [min, max] = [0, 1];
    const kind = this.data.kind ?? "line";
    if (kind === "bar" || kind === "area" || (min >= 0 && min < max - min)) {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    return [this.data.yMin ?? min, this.data.yMax ?? max];
  }

  private xyFrame(width: number): XYFrame | undefined {
    const domain = this.window ?? this.fullDomain(this.data);
    const first = this.countBelow(domain[0], false);
    const last = this.countBelow(domain[1], true) - 1;
    const range = this.valueRange(first, last);
    const cell = getCellDimensions();
    const aspect = cell.widthPx / cell.heightPx;
    const rowsTarget = this.options.expanded
      ? Math.min(40, Math.max(12, Math.round(width * aspect * 0.45)))
      : Math.min(18, Math.max(8, Math.round(width * aspect * 0.28)));
    const y = valueTicks(
      range[0],
      range[1],
      Math.max(4, Math.round(rowsTarget / 2.5)),
      this.data.unit,
    );
    const rowsPerTick = Math.max(
      1,
      Math.round((rowsTarget - 1) / (y.values.length - 1)),
    );
    const gutter = Math.max(...y.labels.map((l) => visibleWidth(l))) + 1;
    const plotCols = width - gutter - 3;
    if (plotCols < 16) return undefined;
    const x =
      this.data.x.type === "time"
        ? timeTicks(domain[0], domain[1], plotCols)
        : valueTicks(
            domain[0],
            domain[1],
            Math.max(2, Math.floor(plotCols / 12)),
          );
    const inDomain = x.values.map((v) => v >= domain[0] && v <= domain[1]);
    return {
      rows: (y.values.length - 1) * rowsPerTick + 1,
      rowsPerTick,
      gutter,
      plotCols,
      y,
      x: {
        values: x.values.filter((_, i) => inDomain[i]),
        labels: x.labels.filter((_, i) => inDomain[i]),
      },
      domain,
      first,
      last,
    };
  }

  private drawRange(frame: XYFrame): [number, number] {
    return [
      Math.max(0, frame.first - 1),
      Math.min(countOf(this.data) - 1, frame.last + 1),
    ];
  }

  private xOf(frame: XYFrame, value: number, span: number): number {
    const [d0, d1] = frame.domain;
    return ((value - d0) / (d1 - d0)) * span;
  }

  private yOf(frame: XYFrame, value: number, rowSpan: number): number {
    const top = frame.y.values.at(-1)!;
    const bottom = frame.y.values[0]!;
    return (
      rowSpan / 2 +
      ((top - value) / (top - bottom)) * (frame.rows - 1) * rowSpan
    );
  }

  private yLabel(frame: XYFrame, row: number): string {
    const label =
      row % frame.rowsPerTick === 0
        ? frame.y.labels.at(-1 - row / frame.rowsPerTick)!
        : "";
    return `${this.theme.fg("muted", label.padStart(frame.gutter - 1))} `;
  }

  private baseline(frame: XYFrame): number {
    const top = frame.y.values.at(-1)!;
    const bottom = frame.y.values[0]!;
    return Math.min(top, Math.max(bottom, 0));
  }

  private gridColor(): Rgb {
    return colorToRgb(
      mixColors(
        this.theme.colors.toolSuccessBg,
        this.theme.colors.text,
        0.13,
        "oklch",
      ),
    );
  }

  private placeImage(
    canvas: Canvas,
    level: number,
    cols: number,
    rows: number,
    lines: string[],
  ): boolean {
    const image = renderImage(
      canvas.toPng(level).toString("base64"),
      { widthPx: canvas.width, heightPx: canvas.height },
      {
        maxWidthCells: cols,
        maxHeightCells: rows,
        imageId: this.imageId,
        moveCursor: false,
      },
    );
    if (!image) return false;
    if (getCapabilities().images === "kitty") lines[0] += image.sequence;
    else
      lines[rows - 1] +=
        `${rows > 1 ? `\x1b[${rows - 1}A` : ""}${image.sequence}`;
    return true;
  }

  private xyCanvas(frame: XYFrame): Canvas {
    const spec = this.data;
    const cell = pixelCell();
    const canvas = new Canvas(
      frame.plotCols * cell.widthPx,
      frame.rows * cell.heightPx,
    );
    const grid = this.gridColor();
    for (let row = 0; row < frame.rows; row += frame.rowsPerTick)
      canvas.hline((row + 0.5) * cell.heightPx, grid, 1);
    for (const v of frame.x.values)
      canvas.vline(this.xOf(frame, v, canvas.width), grid, 0.6);

    const colors = this.colors().map(colorToRgb);
    const kind = spec.kind ?? "line";
    const [from, to] = this.drawRange(frame);
    const point = (index: number, value: number): Point => ({
      x: this.xOf(frame, xAt(spec.x, index), canvas.width),
      y: this.yOf(frame, value, cell.heightPx),
    });
    const baseY = this.yOf(frame, this.baseline(frame), cell.heightPx);

    if (kind === "bar") {
      const slot =
        (canvas.width / (frame.domain[1] - frame.domain[0])) * spacingOf(spec);
      const barWidth = (slot * 0.8) / spec.series.length;
      spec.series.forEach((s, si) => {
        for (let i = from; i <= to; i++) {
          const v = s.values[i];
          if (v === null || v === undefined) continue;
          const { x, y } = point(i, v);
          const left = x - slot * 0.4 + si * barWidth;
          canvas.rect(left + 0.5, y, left + barWidth - 0.5, baseY, colors[si]!);
        }
      });
      return canvas;
    }
    const runs = spec.series.map((s) => {
      const runs: Point[][] = [[]];
      for (let i = from; i <= to; i++) {
        const v = s.values[i];
        if (v === null || v === undefined) runs.push([]);
        else runs.at(-1)!.push(point(i, v));
      }
      return runs.filter((r) => r.length > 0);
    });
    const lineWidth = Math.max(1.5, cell.heightPx / 13);
    if (kind === "area")
      runs.forEach((r, i) =>
        canvas.fillUnder(
          r,
          baseY,
          colors[i]!,
          spec.series.length > 1 ? 0.16 : 0.26,
        ),
      );
    runs.forEach((r, i) =>
      kind === "scatter"
        ? canvas.dots(r.flat(), lineWidth * 1.3, colors[i]!)
        : canvas.stroke(r, lineWidth, colors[i]!),
    );
    return canvas;
  }

  private pixelLines(frame: XYFrame, base: Canvas): string[] | undefined {
    const hover = this.hoverIndex(frame);
    const zoom = this.drag?.mode === "zoom" ? this.drag : undefined;
    const interactive = hover !== undefined || zoom !== undefined;
    const canvas = interactive ? base.clone() : base;
    const cell = pixelCell();
    if (zoom) {
      const accent = colorToRgb(this.theme.colors.accent);
      const [from, to] = [zoom.anchor, zoom.col].sort((a, b) => a - b);
      const left = from! * cell.widthPx;
      const right = (to! + 1) * cell.widthPx;
      canvas.rect(left, 0, right, canvas.height, accent, 0.14);
      canvas.vline(left, accent, 0.8);
      canvas.vline(right, accent, 0.8);
    }
    if (hover !== undefined) {
      const x = this.xOf(frame, xAt(this.data.x, hover), canvas.width);
      canvas.vline(x, colorToRgb(this.theme.colors.text), 0.45);
      const colors = this.colors().map(colorToRgb);
      const nearest = this.nearestSeries(frame, hover);
      const radius = Math.max(2, cell.heightPx / 9);
      this.data.series.forEach((s, si) => {
        const v = s.values[hover];
        if (v === null || v === undefined) return;
        const p = { x, y: this.yOf(frame, v, cell.heightPx) };
        const r = si === nearest ? radius * 1.4 : radius;
        canvas.dots([p], r * 2.2, colors[si]!, 0.25);
        canvas.dots([p], r, colors[si]!);
      });
    }
    const lines = Array.from({ length: frame.rows }, (_, row) =>
      this.yLabel(frame, row),
    );
    return this.placeImage(
      canvas,
      interactive ? 1 : 6,
      frame.plotCols,
      frame.rows,
      lines,
    )
      ? lines
      : undefined;
  }

  private xyBraille(frame: XYFrame): string[] {
    const { theme } = this;
    const spec = this.data;
    const { plotCols, rows } = frame;
    const dotCols = plotCols * 2;
    const dotRows = rows * 4;
    const bits = new Uint8Array(plotCols * rows);
    const owner = new Int16Array(plotCols * rows).fill(-1);
    const plotDot = (x: number, y: number, series: number) => {
      if (x < 0 || x >= dotCols || y < 0 || y >= dotRows) return;
      const index = (y >> 2) * plotCols + (x >> 1);
      bits[index]! |= BRAILLE_DOTS[y & 3]![x & 1]!;
      owner[index] = series;
    };
    const kind = spec.kind ?? "line";
    const dotOf = (i: number, v: number) => ({
      x: Math.round(this.xOf(frame, xAt(spec.x, i), dotCols) - 0.5),
      y: Math.round(this.yOf(frame, v, 4) - 0.5),
    });
    const baseDot = Math.round(this.yOf(frame, this.baseline(frame), 4) - 0.5);
    const [from, to] = this.drawRange(frame);
    spec.series.forEach((s, si) => {
      let previous: Point | undefined;
      for (let i = from; i <= to; i++) {
        const v = s.values[i];
        if (v === null || v === undefined) {
          previous = undefined;
          continue;
        }
        const p = dotOf(i, v);
        if (kind === "bar" || kind === "area") {
          const [lo, hi] = p.y <= baseDot ? [p.y, baseDot] : [baseDot, p.y];
          for (let y = lo; y <= hi; y++) plotDot(p.x, y, si);
        }
        if (kind !== "scatter" && kind !== "bar" && previous) {
          const n = Math.max(
            Math.abs(p.x - previous.x),
            Math.abs(p.y - previous.y),
            1,
          );
          for (let k = 0; k <= n; k++) {
            const x = Math.round(previous.x + ((p.x - previous.x) * k) / n);
            const y = Math.round(previous.y + ((p.y - previous.y) * k) / n);
            plotDot(x, y, si);
            if (kind === "area") {
              const [lo, hi] = y <= baseDot ? [y, baseDot] : [baseDot, y];
              for (let fy = lo; fy <= hi; fy++) plotDot(x, fy, si);
            }
          }
        }
        plotDot(p.x, p.y, si);
        previous = p;
      }
    });
    const colors = this.colors();
    return Array.from({ length: rows }, (_, row) => {
      let line = this.yLabel(frame, row);
      for (let col = 0; col < plotCols; col++) {
        const index = row * plotCols + col;
        const s = owner[index]!;
        line +=
          s < 0
            ? " "
            : theme.style(String.fromCodePoint(0x2800 + bits[index]!), {
                fg: colors[s]!,
              });
      }
      return line;
    });
  }

  private barPlot(width: number): Plot {
    const { theme } = this;
    const spec = this.data;
    if (spec.x.type !== "category") return { lines: [], axis: "" };
    const categories = spec.x.categories;
    const limit = this.options.expanded ? 100 : 20;
    const shown = categories.slice(0, limit);
    const range = this.valueRange(0, shown.length - 1);
    const valueText = (i: number) =>
      spec.series
        .map((s) =>
          s.values[i] === null ? "–" : formatValue(s.values[i]!, spec.unit),
        )
        .join(" / ");
    const valueWidth = Math.max(
      ...shown.map((_, i) => visibleWidth(valueText(i))),
    );
    const labelWidth = Math.min(
      Math.max(...shown.map((c) => visibleWidth(c))),
      Math.max(6, Math.floor(width * 0.35)),
    );
    const gutter = labelWidth + valueWidth + 3;
    const plotCols = width - gutter - 2;
    if (plotCols < 10) return { lines: [], axis: "" };
    const ticks = valueTicks(
      range[0],
      range[1],
      Math.max(2, Math.floor(plotCols / 12)),
      spec.unit,
    );
    const domain: Window = [ticks.values[0]!, ticks.values.at(-1)!];
    const xOf = (v: number, span: number) =>
      ((v - domain[0]) / (domain[1] - domain[0])) * span;
    const gutterText = (i: number) =>
      `${theme.fg("toolOutput", truncateToWidth(shown[i]!, labelWidth, "…", true))} ${theme.fg("text", valueText(i).padStart(valueWidth))} ${theme.fg("dim", "│")}`;
    const colors = this.colors();
    const lines: string[] = [];

    if (this.usePixels) {
      const cell = pixelCell();
      const canvas = new Canvas(
        plotCols * cell.widthPx,
        shown.length * cell.heightPx,
      );
      const grid = this.gridColor();
      for (const v of ticks.values)
        canvas.vline(xOf(v, canvas.width), grid, 0.6);
      const zero = xOf(
        Math.min(domain[1], Math.max(domain[0], 0)),
        canvas.width,
      );
      const band = (cell.heightPx * 0.7) / spec.series.length;
      shown.forEach((_, i) =>
        spec.series.forEach((s, si) => {
          const v = s.values[i];
          if (v === null || v === undefined) return;
          const top = i * cell.heightPx + cell.heightPx * 0.15 + si * band;
          canvas.rect(
            zero,
            top,
            xOf(v, canvas.width),
            top + band - (spec.series.length > 1 ? 1 : 0),
            colorToRgb(colors[si]!),
          );
        }),
      );
      lines.push(...shown.map((_, i) => gutterText(i)));
      if (!this.placeImage(canvas, 6, plotCols, shown.length, lines))
        lines.length = 0;
    }
    if (lines.length === 0) {
      shown.forEach((_, i) => {
        spec.series.forEach((s, si) => {
          const v = s.values[i];
          const cells =
            v === null || v === undefined
              ? 0
              : Math.max(
                  0,
                  xOf(v, plotCols) - xOf(Math.max(domain[0], 0), plotCols),
                );
          const eighths = Math.round(cells * 8);
          const bar = "█".repeat(eighths >> 3) + EIGHTHS[eighths & 7]!;
          const prefix = si === 0 ? gutterText(i) : " ".repeat(gutter);
          lines.push(prefix + theme.style(bar, { fg: colors[si]! }));
        });
      });
    }
    if (categories.length > shown.length)
      lines.push(
        theme.fg(
          "dim",
          `${" ".repeat(gutter)}… ${categories.length - shown.length} more`,
        ),
      );
    return {
      lines,
      axis: this.axisRow(width, gutter, plotCols, ticks, domain),
    };
  }

  private axisRow(
    width: number,
    gutter: number,
    plotCols: number,
    ticks: Ticks,
    domain: Window,
  ): string {
    let line = "";
    let free = gutter;
    ticks.values.forEach((v, i) => {
      const label = ticks.labels[i]!;
      const center =
        gutter +
        Math.round(((v - domain[0]) / (domain[1] - domain[0])) * plotCols);
      const start = Math.min(
        width - label.length,
        Math.max(gutter, center - (label.length >> 1)),
      );
      if (start < free) return;
      line +=
        " ".repeat(start - visibleWidth(line)) + this.theme.fg("muted", label);
      free = start + label.length + 2;
    });
    return line;
  }

  private pointerAxis(frame: XYFrame, width: number): string | undefined {
    const { theme } = this;
    const zoom = this.drag?.mode === "zoom" ? this.drag : undefined;
    if (zoom) {
      const [from, to] = [zoom.anchor, zoom.col].sort((a, b) => a - b);
      const marks =
        to === from ? "│" : `├${"─".repeat(Math.max(0, to! - from! - 1))}┤`;
      const label = `${this.xLabel(this.xFromCol(frame, from!))} – ${this.xLabel(this.xFromCol(frame, to! + 1))}`;
      return truncateToWidth(
        `${" ".repeat(frame.gutter + from!)}${theme.fg("accent", marks)} ${theme.fg("accent", label)}`,
        width,
      );
    }
    const hover = this.hoverIndex(frame);
    if (hover === undefined) return undefined;
    const col =
      frame.gutter +
      Math.min(
        frame.plotCols - 1,
        Math.max(
          0,
          Math.floor(this.xOf(frame, xAt(this.data.x, hover), frame.plotCols)),
        ),
      );
    const caret = theme.fg(
      "accent",
      `▲ ${this.xLabel(xAt(this.data.x, hover))}`,
    );
    const hint = `drag: zoom · drag or scroll axis: pan, zoom${this.window ? " · double-click: reset" : ""}`;
    const caretEnd = col + visibleWidth(caret);
    if (width - caretEnd >= hint.length + 2)
      return `${" ".repeat(col)}${caret}${" ".repeat(width - caretEnd - hint.length)}${theme.fg("dim", hint)}`;
    if (col - frame.gutter >= hint.length + 2)
      return truncateToWidth(
        `${" ".repeat(frame.gutter)}${theme.fg("dim", hint)}${" ".repeat(col - frame.gutter - hint.length)}${caret}`,
        width,
      );
    return truncateToWidth(`${" ".repeat(col)}${caret}`, width);
  }

  private legend(width: number, frame: XYFrame | undefined): string[] {
    const { theme } = this;
    const spec = this.data;
    if (spec.x.type === "category" && spec.series.length === 1) return [];
    const colors = this.colors();
    const hover = frame ? this.hoverIndex(frame) : undefined;
    const nearest =
      frame && hover !== undefined
        ? this.nearestSeries(frame, hover)
        : undefined;
    const [first, last] = frame
      ? [frame.first, frame.last]
      : [0, countOf(spec) - 1];
    const columns = spec.series.map((s): string[] => {
      if (spec.x.type === "category") return [];
      if (hover !== undefined) {
        const v = s.values[hover];
        if (v === null || v === undefined) return ["–", ""];
        const previous = s.values[hover - 1];
        const delta =
          previous === null || previous === undefined
            ? undefined
            : v - previous;
        return [
          formatValue(v, spec.unit),
          delta === undefined || delta === 0
            ? ""
            : `${delta > 0 ? "▲" : "▼"} ${formatValue(Math.abs(delta), spec.unit)}`,
        ];
      }
      const stats = seriesStats({
        ...s,
        values: s.values.slice(Math.max(0, first), last + 1),
      });
      if (!stats) return ["no data"];
      const lastValue = formatValue(stats.last, spec.unit);
      if (!this.options.expanded) return [lastValue];
      return [
        `last ${lastValue}`,
        `min ${formatValue(stats.min, spec.unit)}`,
        `max ${formatValue(stats.max, spec.unit)}`,
        `mean ${formatValue(stats.mean, spec.unit)}`,
      ];
    });
    const widths: number[] = [];
    for (const row of columns)
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
      });
    const valuesWidth = widths.reduce((sum, w) => sum + w + 2, 0);
    const labelWidth = Math.max(
      4,
      Math.min(
        Math.max(...spec.series.map((s) => visibleWidth(s.name))),
        width - valuesWidth - 4,
      ),
    );
    return spec.series.map((s, i) => {
      const emphasis = i === nearest;
      const name = truncateToWidth(s.name, labelWidth, "…", true);
      const cells = columns[i]!.map((cell, c) =>
        theme.fg(
          c === 0 ? "text" : "dim",
          c === 0 ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!),
        ),
      );
      return truncateToWidth(
        `${theme.style("━━ ", { fg: colors[i]! })}${emphasis ? theme.bold(theme.fg("text", name)) : theme.fg("toolOutput", name)}${" ".repeat(Math.max(0, labelWidth - visibleWidth(name)))}  ${cells.join("  ")}`,
        width,
      );
    });
  }

  private statusLine(width: number, frame: XYFrame | undefined): string[] {
    if (this.status)
      return [
        truncateToWidth(
          this.theme.fg(this.status.error ? "error" : "dim", this.status.text),
          width,
        ),
      ];
    if (!this.window || !frame) return [];
    const [a, b] = frame.domain;
    return [
      truncateToWidth(
        this.theme.fg(
          "dim",
          `${this.xLabel(a)} – ${this.xLabel(b)} · double-click to reset`,
        ),
        width,
      ),
    ];
  }
}
