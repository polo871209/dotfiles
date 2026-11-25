import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { niceDuration } from "../shared/chart/scale";
import type { ChartSeries } from "../shared/chart/spec";
import { type ChartLoad, registerChartTool } from "../shared/chart/tool";

const SHOWN_SERIES = 10;
const TARGET_POINTS = 480;

const DURATION_UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000,
};

function parseDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text)
    throw new Error(
      `"${text}" is not a Prometheus duration such as 90s, 6h, or 1d12h.`,
    );
  return parts.reduce(
    (sum, [, n, unit]) => sum + Number(n) * DURATION_UNITS[unit!]!,
    0,
  );
}

function parseTime(text: string): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms))
    throw new Error(`"${text}" is not an RFC 3339 time or Unix timestamp.`);
  return ms / 1000;
}

/** Unit from Prometheus naming conventions (https://prometheus.io/docs/practices/naming/#base-units). */
function unitOf(query: string): string | undefined {
  const perSecond = /\b(?:i?rate|deriv)\s*\(/.test(query);
  if (/_bytes(?:_total)?\b/.test(query)) return perSecond ? "bytes/s" : "bytes";
  if (/_seconds_bucket\b/.test(query)) return "seconds";
  if (/_seconds(?:_sum|_count)?\b/.test(query) && !perSecond) return "seconds";
  if (/_ratio\b/.test(query)) return "ratio";
  return undefined;
}

function seriesNames(metrics: Record<string, string>[], name: string): string[] {
  if (metrics.length === 1) return [name];
  const keys = [...new Set(metrics.flatMap((m) => Object.keys(m)))];
  const varying = keys.filter(
    (key) => key !== "__name__" && new Set(metrics.map((m) => m[key])).size > 1,
  );
  return metrics.map((m) => {
    const pairs = varying
      .filter((key) => m[key] !== undefined)
      .map((key) => `${key}="${m[key]}"`);
    return pairs.length === 0 ? name : `${name}{${pairs.join(", ")}}`;
  });
}

function request(base: string, body: URLSearchParams): Request {
  const url = new URL(
    "api/v1/query_range",
    base.endsWith("/") ? base : `${base}/`,
  );
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  // fetch() rejects a URL that carries credentials, so they move to a header.
  if (url.username) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.set("authorization", `Basic ${btoa(credentials)}`);
    url.username = "";
    url.password = "";
  }
  if (process.env.PROMETHEUS_TOKEN)
    headers.set("authorization", `Bearer ${process.env.PROMETHEUS_TOKEN}`);
  return new Request(url, { method: "POST", headers, body });
}

type PromResponse = {
  status: "success" | "error";
  data?: {
    result: {
      metric: Record<string, string>;
      values?: [number, string][];
      histograms?: unknown[];
    }[];
  };
  errorType?: string;
  /** A string from Prometheus, an object from Google API frontends such as Managed Prometheus. */
  error?: string | { message?: string };
  warnings?: string[];
  infos?: string[];
};

const parameters = Type.Object({
  queries: Type.Record(Type.String(), Type.String({ minLength: 1 }), {
    description:
      'Series name to PromQL expression, all drawn in one chart, such as {"usage": "...", "request": "..."}',
  }),
  server: Type.Optional(
    Type.String({
      description: "Prometheus base URL. Default: PROMETHEUS_URL.",
    }),
  ),
  range: Type.Optional(
    Type.String({
      description: "Prometheus duration ending at `end`, such as 7d. Default: 1h.",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "RFC 3339 time or Unix seconds. Default: now.",
    }),
  ),
  step: Type.Optional(
    Type.String({
      description: `Prometheus duration between points. Default: range / ${TARGET_POINTS}, rounded up to a whole interval.`,
    }),
  ),
  unit: Type.Optional(
    Type.String({
      description:
        "Value unit such as bytes, seconds, ratio, or req/s. Default: inferred from metric name suffixes.",
    }),
  ),
});

type Params = Static<typeof parameters>;

async function fetchMatrix(
  server: string,
  query: string,
  start: number,
  end: number,
  step: number,
  signal: AbortSignal | undefined,
): Promise<{ result: NonNullable<PromResponse["data"]>["result"]; notes: string[] }> {
  const response = await fetch(
    request(
      server,
      new URLSearchParams({
        query,
        start: String(start),
        end: String(end),
        step: String(step),
      }),
    ),
    {
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(60_000),
      ]),
    },
  );
  const body = (await response.json().catch(() => undefined)) as
    | PromResponse
    | undefined;
  if (!body)
    throw new Error(`Prometheus answered HTTP ${response.status} without JSON.`);
  if (body.status !== "success" || !body.data) {
    const reason =
      typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(
      `${body.errorType ?? `HTTP ${response.status}`}: ${reason ?? JSON.stringify(body)}`,
    );
  }
  const notes = [...(body.warnings ?? []), ...(body.infos ?? [])];
  const histograms = body.data.result.filter((s) => s.histograms?.length).length;
  if (histograms)
    notes.push(
      `${histograms} native histogram series skipped. Wrap them in histogram_quantile() or histogram_count().`,
    );
  return { result: body.data.result, notes };
}

async function queryRange(
  params: Params,
  from: number,
  to: number,
  step: number,
  signal: AbortSignal | undefined,
): Promise<ChartLoad> {
  const server = params.server ?? process.env.PROMETHEUS_URL;
  if (!server)
    throw new Error("Pass server, the Prometheus base URL, or set PROMETHEUS_URL.");
  const queries = Object.entries(params.queries);
  if (queries.length === 0) throw new Error("Pass at least one query.");
  const end = Math.floor(to / step) * step;
  const start = Math.floor(from / step) * step;
  const count = Math.round((end - start) / step) + 1;
  const answers = await Promise.all(
    queries.map(([, query]) =>
      fetchMatrix(server, query, start, end, step, signal),
    ),
  );

  const notes: string[] = [];
  const all = answers.flatMap(({ result, notes: queryNotes }, q) => {
    const [name, query] = queries[q]!;
    notes.push(...queryNotes.map((n) => `${name}: ${n}`));
    const matched = result
      .filter((s) => s.values?.length)
      .sort((a, b) =>
        JSON.stringify(a.metric).localeCompare(JSON.stringify(b.metric)),
      );
    if (matched.length === 0) notes.push(`${name}: no data in this range: ${query}`);
    const names = seriesNames(
      matched.map((s) => s.metric),
      name,
    );
    return matched.map((s, i) => {
      const values: (number | null)[] = Array(count).fill(null);
      let peak = -Infinity;
      for (const [t, raw] of s.values!) {
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        values[Math.round((t - start) / step)] = Number(v.toPrecision(7));
        peak = Math.max(peak, v);
      }
      return { name: names[i]!, values, peak };
    });
  });
  if (all.length === 0)
    throw new Error("No query matched any series in this range.");
  if (all.length > SHOWN_SERIES)
    notes.push(
      `Showing the ${SHOWN_SERIES} series with the highest peak of ${all.length}. Use topk() or an aggregation to pick others.`,
    );
  const shown = new Set(
    [...all].sort((a, b) => b.peak - a.peak).slice(0, SHOWN_SERIES),
  );
  const series: ChartSeries[] = all
    .filter((s) => shown.has(s))
    .map(({ name, values }) => ({ name, values }));
  const units = new Set(
    queries
      .filter((_, q) => answers[q]!.result.some((s) => s.values?.length))
      .map(([, query]) => unitOf(query)),
  );

  return {
    spec: {
      kind: "line",
      x: { type: "time", start, step },
      unit: params.unit ?? (units.size === 1 ? [...units][0] : undefined),
      series,
    },
    notes,
  };
}

export default function (pi: ExtensionAPI) {
  registerChartTool(pi, {
    name: "promql_chart",
    label: "promql",
    description:
      "Run PromQL range queries and show the result to the user as one chart in the terminal. Returns last, min, max, and mean per series, for at most 10 series ranked by peak.",
    parameters,
    annotations: { readOnlyHint: true, openWorldHint: true },
    headline: (args) =>
      `${Object.keys(args.queries ?? {}).join(", ")} ${args.range ?? "1h"}`,

    async load(params, signal) {
      const range = parseDuration(params.range ?? "1h");
      const step = params.step
        ? parseDuration(params.step)
        : niceDuration(range / TARGET_POINTS);
      const end = params.end ? parseTime(params.end) : Date.now() / 1000;
      return queryRange(params, end - range, end, step, signal);
    },

    async reload(params, [start, end], signal) {
      const step = niceDuration((end - start) / TARGET_POINTS);
      return (await queryRange(params, start, end, step, signal)).spec;
    },
  });
}
