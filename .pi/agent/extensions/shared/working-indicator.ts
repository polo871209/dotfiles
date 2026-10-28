import type { Theme } from "@earendil-works/pi-coding-agent";

export const WORKING_FRAME_MS = 150;

export const workingFrames = (theme: Theme): string[] => [
  theme.fg("dim", "·"),
  theme.fg("muted", "•"),
  theme.fg("accent", "●"),
  theme.fg("muted", "•"),
];
