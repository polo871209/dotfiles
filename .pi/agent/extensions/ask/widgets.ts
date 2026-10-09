import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { QuestionData } from "./schema";
import { sentinelLabel } from "./schema";

function wrapInlineInput(
  buffer: string,
  cursorOffset: number | undefined,
  contentWidth: number,
): string[] {
  const offset =
    cursorOffset !== undefined &&
    cursorOffset >= 0 &&
    cursorOffset <= buffer.length
      ? cursorOffset
      : buffer.length;
  const [firstGrapheme] = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(buffer.slice(offset));
  const rawAt = firstGrapheme ? firstGrapheme.segment : "";
  return wrapTextWithAnsi(
    `${buffer.slice(0, offset)}${CURSOR_MARKER}\x1b[7m${rawAt === "" || rawAt === " " ? "\u00a0" : rawAt}\x1b[27m${buffer.slice(offset + rawAt.length)}`,
    contentWidth,
  );
}

export type WrappingSelectItem =
  | { kind: "option"; label: string; description?: string }
  | { kind: "other"; label: string; description?: string }
  | { kind: "next"; label: string; description?: string };

export interface WrappingSelectTheme {
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
}

class WrappingSelect implements Component {
  private static readonly ACTIVE_POINTER = "→ ";
  private static readonly INACTIVE_POINTER = "  ";
  private static readonly CONFIRMED_MARK = " ✔";
  private static readonly MIN_CONTENT_WIDTH = 1;

  private readonly items: readonly WrappingSelectItem[];
  private readonly maxVisible: number;
  private readonly theme: WrappingSelectTheme;

  private selectedIndex = 0;
  private focused = true;
  private inputBuffer = "";
  private inputCursorOffset: number | undefined = undefined;
  private confirmedIndex: number | undefined = undefined;
  private confirmedLabelOverride: string | undefined = undefined;

  constructor(
    items: readonly WrappingSelectItem[],
    maxVisible: number,
    theme: WrappingSelectTheme,
  ) {
    this.items = items;
    this.maxVisible = Math.max(1, maxVisible);
    this.theme = theme;
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  setConfirmedIndex(index: number | undefined, labelOverride?: string): void {
    if (index === undefined) {
      this.confirmedIndex = undefined;
      this.confirmedLabelOverride = undefined;
      return;
    }
    this.confirmedIndex = Math.max(0, Math.min(index, this.items.length - 1));
    this.confirmedLabelOverride = labelOverride;
  }

  setInputBuffer(text: string): void {
    this.inputBuffer = text;
  }

  setInputCursorOffset(offset: number | undefined): void {
    this.inputCursorOffset = offset;
  }

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    if (this.items.length === 0) return [];

    const { startIndex, endIndex } = this.computeVisibleWindow();
    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;
      lines.push(
        ...this.renderItem(
          item,
          i,
          i === this.selectedIndex && this.focused,
          width,
        ),
      );
    }

    if (this.hasItemsOutsideWindow(startIndex, endIndex)) {
      lines.push(
        this.theme.scrollInfo(
          `  (${this.selectedIndex + 1}/${this.items.length})`,
        ),
      );
    }
    return lines;
  }

  focusedItemRowRange(width: number): [number, number] {
    if (this.items.length === 0) return [0, 0];
    const { startIndex, endIndex } = this.computeVisibleWindow();
    let row = 0;
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;
      const itemRowCount = this.renderItem(
        item,
        i,
        i === this.selectedIndex && this.focused,
        width,
      ).length;
      if (i === this.selectedIndex) return [row, row + itemRowCount];
      row += itemRowCount;
    }
    return [0, 1];
  }

  private computeVisibleWindow(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.items.length - this.maxVisible,
      ),
    );
    return {
      startIndex,
      endIndex: Math.min(startIndex + this.maxVisible, this.items.length),
    };
  }

  private hasItemsOutsideWindow(startIndex: number, endIndex: number): boolean {
    return startIndex > 0 || endIndex < this.items.length;
  }

  private renderItem(
    item: WrappingSelectItem,
    index: number,
    isActive: boolean,
    width: number,
  ): string[] {
    const rowPrefix = isActive
      ? WrappingSelect.ACTIVE_POINTER
      : WrappingSelect.INACTIVE_POINTER;
    const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
    const contentWidth = Math.max(
      WrappingSelect.MIN_CONTENT_WIDTH,
      width - visibleWidth(rowPrefix),
    );

    if (item.kind === "other" && isActive) {
      return this.renderInlineInputRow(
        rowPrefix,
        continuationPrefix,
        contentWidth,
      );
    }

    const isConfirmed = index === this.confirmedIndex;

    return [
      ...this.renderLabelBlock(
        isConfirmed
          ? `${this.confirmedLabelOverride ?? item.label}${WrappingSelect.CONFIRMED_MARK}`
          : item.label,
        rowPrefix,
        continuationPrefix,
        contentWidth,
        isActive || isConfirmed,
      ),
      ...this.renderDescriptionBlock(
        item.description,
        continuationPrefix,
        contentWidth,
      ),
    ];
  }

  private renderInlineInputRow(
    rowPrefix: string,
    continuationPrefix: string,
    contentWidth: number,
  ): string[] {
    return wrapInlineInput(
      this.inputBuffer,
      this.inputCursorOffset,
      contentWidth,
    ).map((segment, index) => {
      return this.theme.selectedText(
        `${index === 0 ? rowPrefix : continuationPrefix}${segment}`,
      );
    });
  }

  private renderLabelBlock(
    label: string,
    rowPrefix: string,
    continuationPrefix: string,
    contentWidth: number,
    applySelectedStyle: boolean,
  ): string[] {
    return wrapTextWithAnsi(label, contentWidth).map((segment, index) => {
      const line = `${index === 0 ? rowPrefix : continuationPrefix}${segment}`;
      return applySelectedStyle ? this.theme.selectedText(line) : line;
    });
  }

  private renderDescriptionBlock(
    description: string | undefined,
    continuationPrefix: string,
    contentWidth: number,
  ): string[] {
    if (!description) return [];
    return wrapTextWithAnsi(description, contentWidth).map(
      (segment) => `${continuationPrefix}${this.theme.description(segment)}`,
    );
  }
}

export interface OptionListViewProps {
  selectedIndex: number;
  focused: boolean;
  inputBuffer: string;
  inputCursorOffset?: number;
  confirmed?: { index: number; labelOverride?: string };
}

export class OptionListView {
  private readonly select: WrappingSelect;

  constructor(
    items: readonly WrappingSelectItem[],
    theme: WrappingSelectTheme,
  ) {
    this.select = new WrappingSelect(items, Math.min(items.length, 10), theme);
  }

  setProps(props: OptionListViewProps): void {
    this.select.setSelectedIndex(props.selectedIndex);
    this.select.setFocused(props.focused);
    this.select.setConfirmedIndex(
      props.confirmed?.index,
      props.confirmed?.labelOverride,
    );
    this.select.setInputBuffer(props.inputBuffer);
    this.select.setInputCursorOffset(props.inputCursorOffset);
  }

  invalidate(): void {
    this.select.invalidate();
  }

  render(width: number): string[] {
    return this.select.render(width);
  }

  focusedItemRowRange(width: number): [number, number] {
    return this.select.focusedItemRowRange(width);
  }

  naturalHeight(width: number): number {
    return this.select.render(width).length;
  }
}

export const MULTI_SUBMIT_LABEL = "Submit";

const MS_ACTIVE_POINTER = "→ ";
const MS_INACTIVE_POINTER = "  ";
const MS_UNCHECKED = "[ ]";
const MS_BOX_LABEL_GAP = " ";

export interface MultiSelectViewProps {
  rows: ReadonlyArray<{ checked: boolean; active: boolean }>;
  other: { active: boolean; text: string; cursorOffset?: number };
  nextActive: boolean;
  nextLabel: string;
}

export class MultiSelectView {
  private props: MultiSelectViewProps;

  constructor(
    private readonly theme: Theme,
    private readonly question: QuestionData,
  ) {
    this.props = {
      rows: [],
      other: { active: false, text: "" },
      nextActive: false,
      nextLabel: sentinelLabel("next"),
    };
  }

  setProps(props: MultiSelectViewProps): void {
    this.props = props;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.layout(width).lines;
  }

  focusedItemRowRange(width: number): [number, number] {
    return this.layout(width).focused ?? [0, 0];
  }

  naturalHeight(width: number): number {
    return this.layout(width).lines.length;
  }

  private layout(width: number): {
    lines: string[];
    focused?: [number, number];
  } {
    const lines: string[] = [];
    let focused: [number, number] | undefined;
    const push = (active: boolean, rowLines: string[]) => {
      if (active) focused = [lines.length, lines.length + rowLines.length];
      lines.push(...rowLines);
    };
    const contentWidth = Math.max(1, width - this.prefixVisibleWidth());

    for (let i = 0; i < this.question.options.length; i++) {
      const opt = this.question.options[i];
      const row = this.props.rows[i];
      if (!opt || !row) continue;
      const label = truncateToWidth(opt.label, contentWidth, "…");
      const rowLines = [
        truncateToWidth(
          `${this.rowPrefix(row.active, row.checked)}${row.active ? this.theme.fg("accent", label) : label}`,
          width,
          "",
        ),
      ];
      if (opt.description) {
        for (const segment of wrapTextWithAnsi(opt.description, contentWidth)) {
          rowLines.push("  " + this.theme.fg("muted", segment));
        }
      }
      push(row.active, rowLines);
    }

    push(this.props.other.active, this.renderOtherRow(width, contentWidth));
    push(this.props.nextActive, [
      truncateToWidth(
        `${
          this.props.nextActive
            ? this.theme.fg("accent", MS_ACTIVE_POINTER)
            : MS_INACTIVE_POINTER
        }${
          this.props.nextActive
            ? this.theme.fg("accent", this.props.nextLabel)
            : this.props.nextLabel
        }`,
        width,
        "",
      ),
    ]);

    return { lines, focused };
  }

  private renderOtherRow(width: number, contentWidth: number): string[] {
    const { active, text, cursorOffset } = this.props.other;
    const prefix = this.rowPrefix(active, text.trim().length > 0);
    if (active) {
      return wrapInlineInput(text, cursorOffset, contentWidth).map(
        (segment, index) =>
          (index === 0 ? prefix : " ".repeat(this.prefixVisibleWidth())) +
          this.theme.fg("accent", segment),
      );
    }
    return [
      truncateToWidth(
        `${prefix}${
          text.trim().length > 0
            ? truncateToWidth(text, contentWidth, "…")
            : this.theme.fg("dim", sentinelLabel("other"))
        }`,
        width,
        "",
      ),
    ];
  }

  private rowPrefix(active: boolean, checked: boolean): string {
    return `${
      active ? this.theme.fg("accent", MS_ACTIVE_POINTER) : MS_INACTIVE_POINTER
    }${
      checked
        ? this.theme.fg("accent", "[✔]")
        : this.theme.fg("muted", MS_UNCHECKED)
    }${MS_BOX_LABEL_GAP}`;
  }

  private prefixVisibleWidth(): number {
    return visibleWidth(
      `${MS_INACTIVE_POINTER}${MS_UNCHECKED}${MS_BOX_LABEL_GAP}`,
    );
  }
}

export interface TabBarProps {
  tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
  submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements Component {
  private props: TabBarProps = {
    tabs: [],
    submit: { active: false, allAnswered: false },
  };

  constructor(private readonly theme: Theme) {}

  setProps(props: TabBarProps): void {
    this.props = props;
  }

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const pieces: string[] = [" ← "];
    for (const tab of this.props.tabs) {
      const rawSeg = ` ${tab.answered ? "■" : "□"} ${tab.label} `;
      pieces.push(
        tab.active
          ? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
          : this.theme.fg(tab.answered ? "success" : "muted", rawSeg),
      );
      pieces.push(" ");
    }
    const submitText = " ✓ Submit ";
    pieces.push(
      this.props.submit.active
        ? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
        : this.theme.fg(
            this.props.submit.allAnswered ? "success" : "dim",
            submitText,
          ),
    );
    pieces.push(" →");
    return [truncateToWidth(pieces.join(""), width, ""), ""];
  }
}

export interface SubmitPickerProps {
  rows: ReadonlyArray<{ active: boolean }>;
}

export class SubmitPicker implements Component {
  private props: SubmitPickerProps = {
    rows: [{ active: false }, { active: false }],
  };

  constructor(private readonly theme: Theme) {}

  setProps(props: SubmitPickerProps): void {
    this.props = props;
  }

  handleInput(_data: string): void {}

  invalidate(): void {}

  naturalHeight(_width: number): number {
    return 2;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      const text = i === 0 ? "Submit answers" : "Cancel";
      const active = this.props.rows[i]?.active ?? false;
      lines.push(
        truncateToWidth(
          `${active ? "→ " : "  "}${
            active ? this.theme.fg("accent", text) : this.theme.fg("text", text)
          }`,
          width,
          "",
        ),
      );
    }
    return lines;
  }
}
