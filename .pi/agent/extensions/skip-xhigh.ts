// skip-xhigh — shift+tab thinking cycle skips xhigh/max: high wraps to off.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKIP = new Set(["xhigh", "max"]);
const ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export default function (pi: ExtensionAPI) {
  pi.on("thinking_level_select", (event) => {
    if (!SKIP.has(event.level)) return;
    const i = ORDER.indexOf(event.level as (typeof ORDER)[number]);
    for (let step = 1; step <= ORDER.length; step++) {
      const next = ORDER[(i + step) % ORDER.length];
      if (!SKIP.has(next)) {
        pi.setThinkingLevel(next);
        return;
      }
    }
  });
}
