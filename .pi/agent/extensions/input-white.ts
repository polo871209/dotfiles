import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

const INPUT = "\x1b[38;2;205;214;244m";
const RESET = "\x1b[0m";
const BORDER = /^[\x1b\[[0-9;]*m]*[─ ↑↓0-9more]+[\x1b\[[0-9;]*m]*$/;

const colorInputLine = (line: string) => {
  if (BORDER.test(line)) return line;
  return `${INPUT}${line.replaceAll(RESET, `${RESET}${INPUT}`)}${RESET}`;
};

let installed = false;
const installPatch = () => {
  if (installed) return;
  installed = true;

  const proto = Editor.prototype as unknown as {
    render(width: number): string[];
  };
  const original = proto.render;
  proto.render = function (this: unknown, width: number) {
    return original.call(this, width).map(colorInputLine);
  };
};

export default function (_pi: ExtensionAPI) {
  installPatch();
}
