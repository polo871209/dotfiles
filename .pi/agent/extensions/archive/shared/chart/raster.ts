import { crc32, deflateSync } from "node:zlib";

export type Rgb = { r: number; g: number; b: number };

export type Point = { x: number; y: number };

/** A transparent RGBA canvas with premultiplied float channels, so antialiased edges blend without fringes. */
export class Canvas {
  readonly pixels: Float32Array;
  private readonly coverage: Float32Array;
  private dirty = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Float32Array(width * height * 4);
    this.coverage = new Float32Array(width * height);
  }

  clone(): Canvas {
    const copy = new Canvas(this.width, this.height);
    copy.pixels.set(this.pixels);

    return copy;
  }

  private blend(index: number, color: Rgb, alpha: number): void {
    const p = index * 4;
    const keep = 1 - alpha;
    const px = this.pixels;
    px[p] = (color.r / 255) * alpha + px[p]! * keep;
    px[p + 1] = (color.g / 255) * alpha + px[p + 1]! * keep;
    px[p + 2] = (color.b / 255) * alpha + px[p + 2]! * keep;
    px[p + 3] = alpha + px[p + 3]! * keep;
  }

  /** A one-device-pixel line at fractional y, split over the two rows it straddles. */
  hline(y: number, color: Rgb, alpha: number): void {
    const top = Math.floor(y - 0.5);
    const share = y - 0.5 - top;

    for (const [row, weight] of [
      [top, 1 - share],
      [top + 1, share],
    ] as const) {
      if (row < 0 || row >= this.height || weight <= 0) continue;

      for (let x = 0; x < this.width; x++) this.blend(row * this.width + x, color, alpha * weight);
    }
  }

  vline(x: number, color: Rgb, alpha: number): void {
    const left = Math.floor(x - 0.5);
    const share = x - 0.5 - left;

    for (const [col, weight] of [
      [left, 1 - share],
      [left + 1, share],
    ] as const) {
      if (col < 0 || col >= this.width || weight <= 0) continue;

      for (let y = 0; y < this.height; y++) this.blend(y * this.width + col, color, alpha * weight);
    }
  }

  /** Axis-aligned rectangle with fractional edges, for bars. */
  rect(left: number, top: number, right: number, bottom: number, color: Rgb, alpha = 1): void {
    const [x0, x1] = left <= right ? [left, right] : [right, left];
    const [y0, y1] = top <= bottom ? [top, bottom] : [bottom, top];

    const overlap = (a0: number, a1: number, cell: number) =>
      Math.max(0, Math.min(a1, cell + 1) - Math.max(a0, cell));

    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y++) {
      const cy = overlap(y0, y1, y);

      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x1)); x++)
        this.blend(y * this.width + x, color, alpha * cy * overlap(x0, x1, x));
    }
  }

  dots(points: Point[], radius: number, color: Rgb, alpha = 1): void {
    for (const p of points) this.coverSegment(p, p, radius);
    this.composite(color, alpha);
  }

  /** Vertical gradient under each run of points, from `alpha` at the line to 0 at `floorY`. */
  fillUnder(runs: Point[][], floorY: number, color: Rgb, alpha: number): void {
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1]!;
        const b = run[i]!;
        const x0 = Math.max(0, Math.ceil(a.x - 0.5));
        const x1 = Math.min(this.width - 1, Math.floor(b.x - 0.5));

        for (let x = x0; x <= x1; x++) {
          const f = b.x === a.x ? 0 : (x + 0.5 - a.x) / (b.x - a.x);
          const lineY = a.y + (b.y - a.y) * f;
          const depth = Math.max(1, floorY - lineY);
          const y0 = Math.max(0, Math.floor(lineY));

          for (let y = y0; y < Math.min(this.height, Math.ceil(floorY)); y++) {
            const edge = Math.min(1, Math.max(0, y + 1 - lineY));
            const fade = 1 - (y + 0.5 - lineY) / depth;

            if (edge > 0 && fade > 0) this.blend(y * this.width + x, color, alpha * edge * fade);
          }
        }
      }
    }
  }

  /** Antialiased polyline runs of width `lineWidth`, with round joins and caps, composited once per pixel. */
  stroke(runs: Point[][], lineWidth: number, color: Rgb): void {
    const half = lineWidth / 2;

    for (const run of runs) {
      if (run.length === 1) this.coverSegment(run[0]!, run[0]!, half + 0.75);

      for (let i = 1; i < run.length; i++) this.coverSegment(run[i - 1]!, run[i]!, half);
    }

    this.composite(color);
  }

  private composite(color: Rgb, alpha = 1): void {
    const { x0, y0, x1, y1 } = this.dirty;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const index = y * this.width + x;
        const cover = this.coverage[index]!;

        if (cover <= 0) continue;
        this.blend(index, color, cover * alpha);
        this.coverage[index] = 0;
      }
    }

    this.dirty = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  }

  private coverSegment(a: Point, b: Point, half: number): void {
    const reach = half + 1;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach));
    const x1 = Math.min(this.width - 1, Math.ceil(Math.max(a.x, b.x) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach));
    const y1 = Math.min(this.height - 1, Math.ceil(Math.max(a.y, b.y) + reach));

    if (x0 > x1 || y0 > y1) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;

    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;

      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;

        const t =
          lengthSq === 0
            ? 0
            : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq));

        const ex = px - (a.x + t * dx);
        const ey = py - (a.y + t * dy);
        const cover = Math.min(1, half + 0.5 - Math.sqrt(ex * ex + ey * ey));
        const index = y * this.width + x;

        if (cover > this.coverage[index]!) this.coverage[index] = cover;
      }
    }

    const d = this.dirty;
    d.x0 = Math.min(d.x0, x0);
    d.y0 = Math.min(d.y0, y0);
    d.x1 = Math.max(d.x1, x1);
    d.y1 = Math.max(d.y1, y1);
  }

  /** PNG bytes, straight alpha, filter type Up per row (https://www.w3.org/TR/png-3/). Level 1 trades size for speed on interactive frames. */
  toPng(level = 6): Buffer {
    const { width, height, pixels } = this;
    const stride = width * 4;
    const rgba = new Uint8Array(height * stride);

    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const alpha = pixels[p + 3]!;

      if (alpha <= 0) continue;
      rgba[p] = Math.round((pixels[p]! / alpha) * 255);
      rgba[p + 1] = Math.round((pixels[p + 1]! / alpha) * 255);
      rgba[p + 2] = Math.round((pixels[p + 2]! / alpha) * 255);
      rgba[p + 3] = Math.round(alpha * 255);
    }

    const filtered = new Uint8Array(height * (stride + 1));

    for (let y = 0; y < height; y++) {
      const out = y * (stride + 1);
      filtered[out] = 2;
      const row = y * stride;

      for (let i = 0; i < stride; i++)
        filtered[out + 1 + i] = (rgba[row + i]! - (y > 0 ? rgba[row - stride + i]! : 0)) & 0xff;
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(filtered, { level })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);

  return out;
}
