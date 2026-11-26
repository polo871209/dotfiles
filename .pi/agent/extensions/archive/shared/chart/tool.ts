import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolAnnotations,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import { formatValue } from "./scale";
import {
  type ChartSpec,
  checkSpec,
  type SeriesStats,
  seriesStats,
  seriesStatsSchema,
  xAt,
} from "./spec";
import { ChartView, type ChartViewOptions, trackPointerLeave } from "./view";

let stopPointerTracking: (() => void) | undefined;

export type ChartLoad = {
  spec: ChartSpec;
  /** Lines for the model after the per-series summary, such as warnings from the data source. */
  notes?: string[];
};

/** A data source that produces one chart per call. registerChartTool turns it into a pi tool. */
export type ChartSource<P extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: P;
  annotations: ToolAnnotations;
  /** The call header after the tool label, such as the query. */
  headline(args: Partial<Static<P>>): string;
  load(
    params: Static<P>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ChartLoad>;
  /** Data for another x window, so zoom and pan in the chart can reach past the loaded points. */
  reload?(params: Static<P>, window: [number, number], signal: AbortSignal): Promise<ChartSpec>;
};

const describeX = (spec: ChartSpec): string => {
  const x = spec.x;

  if (x.type === "category") return `${x.categories.length} categories`;
  const count = "values" in x ? x.values.length : spec.series[0]!.values.length;

  const at = (i: number) =>
    x.type === "time" ? new Date(xAt(x, i) * 1000).toISOString() : String(xAt(x, i));

  return `${count} points from ${at(0)} to ${at(count - 1)}`;
};

function summarize(spec: ChartSpec, stats: SeriesStats[]): string[] {
  const unit = spec.unit ? `, unit ${spec.unit}` : "";

  const lines = [
    `${spec.kind ?? "line"} chart of ${spec.series.length} series, ${describeX(spec)}${unit}. The user sees the chart.`,
  ];

  for (const s of stats)
    lines.push(
      `- ${s.name}: last ${formatValue(s.last, spec.unit)}, min ${formatValue(s.min, spec.unit)}, max ${formatValue(s.max, spec.unit)}, mean ${formatValue(s.mean, spec.unit)}`,
    );

  return lines;
}

export function registerChartTool<P extends TSchema>(
  pi: ExtensionAPI,
  source: ChartSource<P>,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopPointerTracking?.();
    stopPointerTracking = trackPointerLeave((handler) => ctx.ui.onTerminalInput(handler));
  });

  pi.registerTool<P, ChartSpec | undefined>({
    name: source.name,
    label: source.label,
    description: source.description,
    parameters: source.parameters,
    annotations: source.annotations,
    // pi renders only top-level tool calls, so a chart drawn from a codemode script never reaches the user.
    exposure: "model-only",
    outputSchema: Type.Object({
      series: Type.Array(seriesStatsSchema),
      notes: Type.Array(Type.String()),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Loading chart data" }],
        details: undefined,
      });
      const { spec, notes = [] } = await source.load(params, signal, ctx);
      checkSpec(spec);
      const stats = spec.series.flatMap((s) => seriesStats(s) ?? []);

      return {
        content: [
          {
            type: "text",
            text: [...summarize(spec, stats), ...notes].join("\n"),
          },
        ],
        details: spec,
        structuredContent: { series: stats, notes },
      };
    },

    renderCall(args, theme, context) {
      const text =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);

      text.setText(
        `${theme.fg("toolTitle", theme.bold(`${source.label} `))}${theme.fg("accent", source.headline(args))}`,
      );

      return text;
    },

    renderResult(result, { expanded, isPartial }, theme: Theme, context) {
      if (isPartial) return new Text(theme.fg("dim", "loading…"), 0, 0);
      const spec = result.details;

      if (context.isError || !spec) {
        const first = result.content.find((c) => c.type === "text");

        return new Text(theme.fg("error", first?.type === "text" ? first.text : "failed"), 0, 0);
      }

      const { reload } = source;

      const options: ChartViewOptions = {
        expanded,
        showImages: context.showImages,
        requestRender: context.invalidate,
        reload: reload && ((window, signal) => reload(context.args, window, signal)),
      };

      if (context.lastComponent instanceof ChartView) {
        context.lastComponent.update(spec, theme, options);

        return context.lastComponent;
      }

      return new ChartView(spec, theme, options);
    },
  });
}
