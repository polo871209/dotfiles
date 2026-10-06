// Bar-prefixed widget factory. First line uses customMessageLabel; the rest
// use customMessageText. Factory shape bypasses pi's 10-line cap on
// array-style widgets (which truncates with "... (widget truncated)").
import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const BAR = "▎ ";

export function barWidget(lines: string[]) {
  return (_tui: unknown, theme: Theme) => {
    const container = new Container();
    const build = () => {
      container.clear();
      lines.forEach((line, i) => {
        const color = i === 0 ? "customMessageLabel" : "customMessageText";
        container.addChild(new Text(theme.fg(color, `${BAR}${line}`), 1, 0));
      });
    };
    build();
    const invalidate = container.invalidate.bind(container);
    container.invalidate = () => {
      build();
      invalidate();
    };
    return container;
  };
}
