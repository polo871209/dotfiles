import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ChartSpec, chartSpecSchema } from "../shared/chart/spec";
import { registerChartTool } from "../shared/chart/tool";

const { x, series, ...options } = chartSpecSchema.properties;

const parameters = Type.Object({
  ...options,
  x: Type.Optional(x),
  series: Type.Optional(series),
  file: Type.Optional(
    Type.String({
      description:
        "CSV, TSV, or JSON file to chart instead of x and series. A table's first column is x and every other column is a series named by its header. JSON is a chart spec or an array of row objects. Write the file in an earlier turn, because calls in one turn run in parallel.",
    }),
  ),
});

type Table = { header: string[]; rows: string[][] };

function parseDelimited(text: string, delimiter: string): Table {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);

      if (record.some((f) => f !== "")) records.push(record);
      record = [];
      field = "";
    } else field += c;
  }

  record.push(field);

  if (record.some((f) => f !== "")) records.push(record);
  const [header, ...rows] = records;

  if (!header || rows.length === 0)
    throw new Error("The table needs a header row and at least one data row.");

  return { header: header.map((h) => h.trim()), rows };
}

function tableFromRecords(records: Record<string, unknown>[]): Table {
  const header = [...new Set(records.flatMap((r) => Object.keys(r)))];

  return {
    header,
    rows: records.map((r) =>
      header.map((key) => (r[key] === null || r[key] === undefined ? "" : String(r[key]))),
    ),
  };
}

function toUnixSeconds(raw: string): number | undefined {
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);

    return n > 1e11 ? n / 1000 : n;
  }

  const ms = Date.parse(raw);

  return Number.isNaN(ms) ? undefined : ms / 1000;
}

function specFromTable(
  { header, rows }: Table,
  kind: ChartSpec["kind"],
): Pick<ChartSpec, "x" | "series" | "kind"> {
  const xs = rows.map((r) => r[0]!.trim());
  const numeric = xs.every((v) => /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v));
  const timeHeader = /time|date|timestamp|^ts$|^t$/i.test(header[0] ?? "");
  const times = xs.map(toUnixSeconds);
  const isTime = (timeHeader || !numeric) && times.every((t) => t !== undefined);
  const order = xs.map((_, i) => i);

  if (isTime || numeric) {
    const key = (i: number) => (isTime ? times[i]! : Number(xs[i]));
    order.sort((a, b) => key(a) - key(b));
  }

  const xAxis: ChartSpec["x"] = isTime
    ? { type: "time", values: order.map((i) => times[i]!) }
    : numeric
      ? { type: "number", values: order.map((i) => Number(xs[i])) }
      : { type: "category", categories: xs };

  const series = header.slice(1).map((name, column) => ({
    name,
    values: order.map((i) => {
      const cell = rows[i]![column + 1]?.trim() ?? "";

      if (cell === "") return null;
      const v = Number(cell);

      if (!Number.isFinite(v))
        throw new Error(`Column "${name}" holds "${cell}", which is not a number.`);

      return v;
    }),
  }));

  if (series.length === 0) throw new Error("The table needs at least one value column.");

  return {
    x: xAxis,
    series,
    kind: kind ?? (xAxis.type === "category" ? "bar" : "line"),
  };
}

async function loadFile(path: string, kind: ChartSpec["kind"]) {
  const text = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();

  if (extension === ".json") {
    const json: unknown = JSON.parse(text);

    if (Array.isArray(json))
      return specFromTable(tableFromRecords(json as Record<string, unknown>[]), kind);

    return json as ChartSpec;
  }

  const delimiter =
    extension === ".tsv" || (!text.includes(",") && text.includes("\t")) ? "\t" : ",";

  return specFromTable(parseDelimited(text, delimiter), kind);
}

export default function (pi: ExtensionAPI) {
  registerChartTool(pi, {
    name: "chart",
    label: "chart",
    description:
      "Show data to the user as a chart in the terminal: line, area, scatter, or bar, over time, numbers, or categories. Pass x and series inline for small data, or a CSV, TSV, or JSON file to keep large data out of the conversation.",
    parameters,
    annotations: { readOnlyHint: true, openWorldHint: false },
    headline: (args) => args.title ?? args.file ?? `${args.series?.length ?? 0} series`,

    async load(params, _signal, ctx) {
      const { file, x, series, ...rest } = params;

      if (file) {
        const fromFile = await loadFile(resolve(ctx.cwd, file.replace(/^@/, "")), rest.kind);

        return {
          spec: { ...fromFile, ...rest, kind: rest.kind ?? fromFile.kind },
        };
      }

      if (!x || !series) throw new Error("Pass x and series, or file.");

      return { spec: { ...rest, x, series } };
    },
  });
}
