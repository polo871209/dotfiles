// Adds optional horizontal padding to the pi TUI.
// Disable with PI_TUI_PADDING=0, or set a custom width (default: 5).
import { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAD = Math.max(
  0,
  Number.parseInt(process.env.PI_TUI_PADDING ?? "5", 10) || 0,
);

const proto = TUI.prototype as unknown as {
  render(width: number): string[];
  __padded?: boolean;
};

if (PAD > 0 && !proto.__padded) {
  proto.__padded = true;
  const origRender = proto.render;
  proto.render = function (width: number): string[] {
    const inner = Math.max(1, width - 2 * PAD);
    const lines = origRender.call(this, inner);
    const pad = " ".repeat(PAD);
    return lines.map((l: string) => pad + l);
  };
}

export default function (_pi: ExtensionAPI) {}
