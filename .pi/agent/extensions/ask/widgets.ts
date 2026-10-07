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

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

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
  const before = buffer.slice(0, offset);
  const [firstGrapheme] = graphemeSegmenter.segment(buffer.slice(offset));
  const rawAt = firstGrapheme ? firstGrapheme.segment : "";
  const unbreakableCursorCell = "\u00a0";
  const atCursor =
    rawAt === "" || rawAt === " " ? unbreakableCursorCell : rawAt;
  const after = buffer.slice(offset + rawAt.length);
  const raw = `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
  return wrapTextWithAnsi(raw, contentWidth);
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
      const isActive = i === this.selectedIndex && this.focused;
      lines.push(...this.renderItem(item, i, isActive, width));
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
      const isActive = i === this.selectedIndex && this.focused;
      const itemRowCount = this.renderItem(item, i, isActive, width).length;
      if (i === this.selectedIndex) return [row, row + itemRowCount];
      row += itemRowCount;
    }
    return [0, 1];
  }

  private computeVisibleWindow(): { startIndex: number; endIndex: number } {
    const half = Math.floor(this.maxVisible / 2);
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - half, this.items.length - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
    return { startIndex, endIndex };
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
    const label = isConfirmed
      ? `${this.confirmedLabelOverride ?? item.label}${WrappingSelect.CONFIRMED_MARK}`
      : item.label;
    const applySelectedStyle = isActive || isConfirmed;

    return [
      ...this.renderLabelBlock(
        label,
        rowPrefix,
        continuationPrefix,
        contentWidth,
        applySelectedStyle,
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
    const wrapped = wrapInlineInput(
      this.inputBuffer,
      this.inputCursorOffset,
      contentWidth,
    );
    return wrapped.map((segment, index) => {
      const prefix = index === 0 ? rowPrefix : continuationPrefix;
      return this.theme.selectedText(`${prefix}${segment}`);
    });
  }

  private renderLabelBlock(
    label: string,
    rowPrefix: string,
    continuationPrefix: string,
    contentWidth: number,
    applySelectedStyle: boolean,
  ): string[] {
    const wrapped = wrapTextWithAnsi(label, contentWidth);
    return wrapped.map((segment, index) => {
      const prefix = index === 0 ? rowPrefix : continuationPrefix;
      const line = `${prefix}${segment}`;
      return applySelectedStyle ? this.theme.selectedText(line) : line;
    });
  }

  private renderDescriptionBlock(
    description: string | undefined,
    continuationPrefix: string,
    contentWidth: number,
  ): string[] {
    if (!description) return [];
    const wrapped = wrapTextWithAnsi(description, contentWidth);
    return wrapped.map(
      (segment) => `${continuationPrefix}${this.theme.description(segment)}`,
    );
  }
}

const MAX_VISIBLE_OPTIONS = 10;

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
    this.select = new WrappingSelect(
      items,
      Math.min(items.length, MAX_VISIBLE_OPTIONS),
      theme,
    );
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
const MS_CHECKED = "[✔]";
const MS_UNCHECKED = "[ ]";
const MS_BOX_LABEL_GAP = " ";
const MS_CONTINUATION_INDENT = "  ";

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
      const styledLabel = row.active ? this.theme.fg("accent", label) : label;
      const rowLines = [
        truncateToWidth(
          `${this.rowPrefix(row.active, row.checked)}${styledLabel}`,
          width,
          "",
        ),
      ];
      if (opt.description) {
        for (const segment of wrapTextWithAnsi(opt.description, contentWidth)) {
          rowLines.push(
            MS_CONTINUATION_INDENT + this.theme.fg("muted", segment),
          );
        }
      }
      push(row.active, rowLines);
    }

    push(this.props.other.active, this.renderOtherRow(width, contentWidth));

    const nextPointer = this.props.nextActive
      ? this.theme.fg("accent", MS_ACTIVE_POINTER)
      : MS_INACTIVE_POINTER;
    const nextLabel = this.props.nextActive
      ? this.theme.fg("accent", this.props.nextLabel)
      : this.props.nextLabel;
    push(this.props.nextActive, [
      truncateToWidth(`${nextPointer}${nextLabel}`, width, ""),
    ]);

    return { lines, focused };
  }

  private renderOtherRow(width: number, contentWidth: number): string[] {
    const { active, text, cursorOffset } = this.props.other;
    const prefix = this.rowPrefix(active, text.trim().length > 0);
    if (active) {
      const continuation = " ".repeat(this.prefixVisibleWidth());
      return wrapInlineInput(text, cursorOffset, contentWidth).map(
        (segment, index) =>
          (index === 0 ? prefix : continuation) +
          this.theme.fg("accent", segment),
      );
    }
    const label =
      text.trim().length > 0
        ? truncateToWidth(text, contentWidth, "…")
        : this.theme.fg("dim", sentinelLabel("other"));
    return [truncateToWidth(`${prefix}${label}`, width, "")];
  }

  private rowPrefix(active: boolean, checked: boolean): string {
    const pointer = active
      ? this.theme.fg("accent", MS_ACTIVE_POINTER)
      : MS_INACTIVE_POINTER;
    const box = checked
      ? this.theme.fg("accent", MS_CHECKED)
      : this.theme.fg("muted", MS_UNCHECKED);
    return `${pointer}${box}${MS_BOX_LABEL_GAP}`;
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
      const box = tab.answered ? "■" : "□";
      const rawSeg = ` ${box} ${tab.label} `;
      const styled = tab.active
        ? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
        : this.theme.fg(tab.answered ? "success" : "muted", rawSeg);
      pieces.push(styled);
      pieces.push(" ");
    }
    const submitText = " ✓ Submit ";
    const submitStyled = this.props.submit.active
      ? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
      : this.theme.fg(
          this.props.submit.allAnswered ? "success" : "dim",
          submitText,
        );
    pieces.push(submitStyled);
    pieces.push(" →");
    return [truncateToWidth(pieces.join(""), width, ""), ""];
  }
}

const SUBMIT_LABEL = "Submit answers";
const CANCEL_LABEL = "Cancel";

const SP_ACTIVE_POINTER = "→ ";
const SP_INACTIVE_POINTER = "  ";

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
      const text = i === 0 ? SUBMIT_LABEL : CANCEL_LABEL;
      const active = this.props.rows[i]?.active ?? false;
      const pointer = active ? SP_ACTIVE_POINTER : SP_INACTIVE_POINTER;
      const label = active
        ? this.theme.fg("accent", text)
        : this.theme.fg("text", text);
      lines.push(truncateToWidth(`${pointer}${label}`, width, ""));
    }
    return lines;
  }
}
