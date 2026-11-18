import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";

export function stepsWidget(title: string, steps: string[], active: number) {
  const lines = [
    title,
    ...steps.map(
      (step, index) =>
        `${index < active ? "✓" : index === active ? "→" : "○"} ${step}`,
    ),
  ];
  return (_tui: unknown, theme: Theme) => {
    const container = new Container();
    const build = () => {
      container.clear();
      lines.forEach((line, i) => {
        container.addChild(
          new Text(
            theme.fg(
              i === 0 ? "customMessageLabel" : "customMessageText",
              `▎ ${line}`,
            ),
            1,
            0,
          ),
        );
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

export function resultCard(
  name: string,
  ok: boolean,
  text: string,
  theme: Theme,
  padding: number,
) {
  const mark = ok
    ? theme.fg("success", `✓ ${name}`)
    : theme.fg("error", `✗ ${name}`);
  const box = new Box(padding, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`${mark} ${text}`, 0, 0));
  return box;
}
