type Prefix = { factor: number; suffix: string };
type Scale = { prefixes: Prefix[]; separator: string; tail: string };

const prefixes = (suffixes: string[], base: number): Prefix[] =>
  suffixes.map((suffix, i) => ({ factor: base ** i, suffix }));

const SI = prefixes(["", "k", "M", "G", "T", "P"], 1000);
const IEC = prefixes(["B", "KiB", "MiB", "GiB", "TiB", "PiB"], 1024);
const DURATION: Prefix[] = [
  { factor: 1e-9, suffix: "ns" },
  { factor: 1e-6, suffix: "µs" },
  { factor: 1e-3, suffix: "ms" },
  { factor: 1, suffix: "s" },
  { factor: 60, suffix: "min" },
  { factor: 3600, suffix: "h" },
  { factor: 86400, suffix: "d" },
];

/** Units with their own prefixes. Any other unit string is a suffix after SI prefixes, such as "req/s". */
export const NAMED_UNITS = {
  bytes: { prefixes: IEC, separator: " ", tail: "" },
  "bytes/s": { prefixes: IEC, separator: " ", tail: "/s" },
  bits: {
    prefixes: prefixes(["b", "kb", "Mb", "Gb", "Tb"], 1000),
    separator: " ",
    tail: "",
  },
  "bits/s": {
    prefixes: prefixes(["b", "kb", "Mb", "Gb", "Tb"], 1000),
    separator: " ",
    tail: "/s",
  },
  seconds: { prefixes: DURATION, separator: " ", tail: "" },
  milliseconds: {
    prefixes: DURATION.map((p) => ({ ...p, factor: p.factor * 1000 })),
    separator: " ",
    tail: "",
  },
  ratio: { prefixes: [{ factor: 0.01, suffix: "%" }], separator: "", tail: "" },
  percent: { prefixes: [{ factor: 1, suffix: "%" }], separator: "", tail: "" },
} satisfies Record<string, Scale>;

function scaleOf(unit: string | undefined): Scale {
  if (unit && unit in NAMED_UNITS)
    return NAMED_UNITS[unit as keyof typeof NAMED_UNITS];
  return { prefixes: SI, separator: "", tail: unit ? ` ${unit}` : "" };
}

function pickPrefix({ prefixes }: Scale, magnitude: number): Prefix {
  if (magnitude === 0)
    return prefixes.find((p) => p.factor === 1) ?? prefixes[0]!;
  return (
    [...prefixes].reverse().find((p) => magnitude >= p.factor) ?? prefixes[0]!
  );
}

const join = (scale: Scale, prefix: Prefix, number: string) =>
  `${number}${prefix.suffix ? scale.separator + prefix.suffix : ""}${scale.tail}`;

export function formatValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return String(value);
  const scale = scaleOf(unit);
  const prefix = pickPrefix(scale, Math.abs(value));
  const scaled = value / prefix.factor;
  const number =
    Math.abs(scaled) >= 1 || scaled === 0
      ? String(Number(scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : 2)))
      : String(Number(scaled.toPrecision(3)));
  return join(scale, prefix, number);
}

function niceStep(raw: number): number {
  const exponent = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].find((n) => raw / exponent <= n) ?? 10;
  return nice * exponent;
}

export type Ticks = { values: number[]; labels: string[] };

/** Round tick values covering [min, max], about `target` of them, labeled in `unit`. */
export function valueTicks(
  min: number,
  max: number,
  target: number,
  unit?: string,
): Ticks {
  let lo = min;
  let hi = max;
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.1 || 1;
    lo -= lo === 0 ? 0 : pad;
    hi += pad;
  }
  const scale = scaleOf(unit);
  const prefix = pickPrefix(scale, Math.max(Math.abs(lo), Math.abs(hi)));
  const step = niceStep((hi - lo) / prefix.factor / Math.max(1, target - 1));
  const decimals =
    String(Number(step.toPrecision(6))).split(".")[1]?.length ?? 0;
  const first = Math.floor(lo / prefix.factor / step + 1e-9);
  const last = Math.max(first + 1, Math.ceil(hi / prefix.factor / step - 1e-9));
  const values: number[] = [];
  const labels: string[] = [];
  for (let i = first; i <= last; i++) {
    values.push(i * step * prefix.factor);
    labels.push(
      i === 0
        ? join(scale, pickPrefix(scale, 0), "0")
        : join(scale, prefix, (i * step).toFixed(decimals)),
    );
  }
  return { values, labels };
}

const TIME_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
  43200, 86400, 172800, 604800, 2592000, 7776000, 31536000,
];

/** The smallest calendar-friendly interval of at least `seconds`. */
export function niceDuration(seconds: number): number {
  return TIME_STEPS.find((s) => s >= seconds) ?? TIME_STEPS.at(-1)!;
}

const utcOffset = (unixSeconds: number) =>
  -new Date(unixSeconds * 1000).getTimezoneOffset() * 60;
const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

export function formatTime(unixSeconds: number, resolution: number): string {
  const d = new Date(unixSeconds * 1000);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (resolution >= 86400) return day;
  return `${day} ${clock}${resolution < 60 ? `:${pad2(d.getSeconds())}` : ""}`;
}

/** Local-time ticks between `start` and `end`, spaced so their labels fit `cells` columns. */
export function timeTicks(start: number, end: number, cells: number): Ticks {
  const labelCells = end - start < 120 ? 8 : 6;
  const interval = niceDuration(
    ((end - start) * (labelCells + 3)) / Math.max(1, cells),
  );
  const values: number[] = [];
  const labels: string[] = [];
  for (
    let local = Math.ceil((start + utcOffset(start)) / interval) * interval;
    local - utcOffset(local) <= end;
    local += interval
  ) {
    const t = local - utcOffset(local - utcOffset(local));
    if (t < start) continue;
    const d = new Date(t * 1000);
    values.push(t);
    labels.push(
      interval >= 86400 || local % 86400 === 0
        ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
        : `${pad2(d.getHours())}:${pad2(d.getMinutes())}${interval < 60 ? `:${pad2(d.getSeconds())}` : ""}`,
    );
  }
  return { values, labels };
}
