import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { NAMED_UNITS } from "./scale";

export const CHART_KINDS = ["line", "area", "scatter", "bar"] as const;

const axisType = Type.Union([Type.Literal("time"), Type.Literal("number")], {
  description: "time: Unix seconds, shown in local time",
});

export const chartSpecSchema = Type.Object({
  kind: Type.Optional(
    StringEnum(CHART_KINDS, {
      description:
        "Default: line. bar draws columns on a time or number x axis and horizontal bars on a category axis.",
    }),
  ),
  title: Type.Optional(Type.String()),
  x: Type.Union([
    Type.Object({ type: axisType, values: Type.Array(Type.Number()) }),
    Type.Object({
      type: axisType,
      start: Type.Number(),
      step: Type.Number({ exclusiveMinimum: 0 }),
    }),
    Type.Object({
      type: Type.Literal("category"),
      categories: Type.Array(Type.String()),
    }),
  ]),
  unit: Type.Optional(
    Type.String({
      description: `Value unit. ${Object.keys(NAMED_UNITS).join(", ")} scale with their own prefixes. Any other text, such as req/s, follows an SI prefix.`,
    }),
  ),
  yMin: Type.Optional(Type.Number()),
  yMax: Type.Optional(Type.Number()),
  series: Type.Array(
    Type.Object({
      name: Type.String(),
      values: Type.Array(Type.Union([Type.Number(), Type.Null()]), {
        description: "One value per x position. null is a gap.",
      }),
      color: Type.Optional(
        Type.String({
          description:
            "#rrggbb or a pi theme color such as error or success. Default: the next theme color.",
        }),
      ),
    }),
    { minItems: 1 },
  ),
});

export type ChartSpec = Static<typeof chartSpecSchema>;

export type ChartSeries = ChartSpec["series"][number];

export type ChartKind = (typeof CHART_KINDS)[number];

export const pointCount = (x: ChartSpec["x"]): number | undefined =>
  "values" in x ? x.values.length : "categories" in x ? x.categories.length : undefined;

export function xAt(x: ChartSpec["x"], index: number): number {
  if ("values" in x) return x.values[index]!;

  if ("start" in x) return x.start + index * x.step;

  return index;
}

/** Throw with the first mismatch the schema cannot express. */
export function checkSpec(spec: ChartSpec): void {
  const expected = pointCount(spec.x);
  const kind = spec.kind ?? "line";

  if (spec.x.type === "category" && kind !== "bar")
    throw new Error(`A category x axis needs kind "bar", not "${kind}".`);

  for (const s of spec.series) {
    if (expected !== undefined && s.values.length !== expected)
      throw new Error(
        `Series "${s.name}" has ${s.values.length} values for ${expected} x positions.`,
      );

    if (s.values.some((v) => v !== null && !Number.isFinite(v)))
      throw new Error(`Series "${s.name}" holds a value that is not finite.`);
  }

  if ("values" in spec.x && spec.x.values.some((v, i, all) => i > 0 && v < all[i - 1]!))
    throw new Error("x values must be in ascending order.");
}

export type SeriesStats = {
  name: string;
  points: number;
  last: number;
  min: number;
  max: number;
  mean: number;
};

export function seriesStats(series: ChartSeries): SeriesStats | undefined {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let points = 0;
  let last = NaN;

  for (const v of series.values) {
    if (v === null) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    points++;
    last = v;
  }

  if (points === 0) return undefined;

  return { name: series.name, points, last, min, max, mean: sum / points };
}

export const seriesStatsSchema = Type.Object({
  name: Type.String(),
  points: Type.Number(),
  last: Type.Number(),
  min: Type.Number(),
  max: Type.Number(),
  mean: Type.Number(),
});
