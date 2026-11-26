import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

const LEGACY: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const KITTY = /^\x1b\[[\d;:]*u$|^\x1b\[[\d;]*:[\d;:]*[A-Z~]$/;

export const terminalBytes = (data: string): string | undefined => {
  if (isKeyRelease(data)) return undefined;
  const paste = PASTE.exec(data);

  if (paste) return paste[1];

  if (!KITTY.test(data)) return data;
  const printable = decodeKittyPrintable(data);

  if (printable) return printable;
  const key = parseKey(data);

  if (!key) return undefined;

  if (key in LEGACY) return LEGACY[key];
  const ctrl = /^ctrl\+([a-z])$/.exec(key);

  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const alt = /^alt\+(.+)$/.exec(key);
  const altKey = alt && (alt[1].length === 1 ? alt[1] : LEGACY[alt[1]]);

  return altKey ? `\x1b${altKey}` : undefined;
};
