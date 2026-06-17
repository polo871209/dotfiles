// Leaf TUI widgets for the questionnaire dialog: the wrapping option list and
// its typed wrappers (option list, multi-select, chat row), plus the tab bar
// and submit picker. Each is purely props-driven via setProps.

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

// Grapheme-aware cursor extraction: pi-tui's Input advances `cursor` by
// grapheme-cluster code-unit length, so the cursor can land between code units
// of one cluster (emoji, ZWJ, combining marks).
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export type WrappingSelectItem =
  | { kind: "option"; label: string; description?: string }
  | { kind: "other"; label: string; description?: string }
  | { kind: "chat"; label: string; description?: string }
  | { kind: "next"; label: string; description?: string };

export interface WrappingSelectTheme {
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
}

export interface WrappingSelectOptions {
  numberStartOffset?: number;
  totalItemsForNumbering?: number;
}

export class WrappingSelect implements Component {
  private static readonly ACTIVE_POINTER = "❯ ";
  private static readonly INACTIVE_POINTER = "  ";
  private static readonly NUMBER_SEPARATOR = ". ";
  private static readonly CONFIRMED_MARK = " ✔";
  private static readonly MIN_CONTENT_WIDTH = 1;

  private readonly items: readonly WrappingSelectItem[];
  private readonly maxVisible: number;
  private readonly theme: WrappingSelectTheme;
  private numberStartOffset: number;
  private totalItemsForNumbering: number;

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
    options: WrappingSelectOptions = {},
  ) {
    this.items = items;
    this.maxVisible = Math.max(1, maxVisible);
    this.theme = theme;
    this.numberStartOffset = options.numberStartOffset ?? 0;
    this.totalItemsForNumbering =
      options.totalItemsForNumbering ?? items.length;
  }

  setNumbering(
    numberStartOffset: number,
    totalItemsForNumbering: number,
  ): void {
    this.numberStartOffset = numberStartOffset;
    this.totalItemsForNumbering = Math.max(1, totalItemsForNumbering);
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
    const numberWidth = String(Math.max(1, this.totalItemsForNumbering)).length;
    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;
      const isActive = i === this.selectedIndex && this.focused;
      lines.push(...this.renderItem(item, i, isActive, width, numberWidth));
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

  /** [startRow, endRow) of the focused item within render(width) output. */
  focusedItemRowRange(width: number): [number, number] {
    if (this.items.length === 0) return [0, 0];
    const { startIndex, endIndex } = this.computeVisibleWindow();
    const numberWidth = String(Math.max(1, this.totalItemsForNumbering)).length;
    let row = 0;
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i];
      if (!item) continue;
      const isActive = i === this.selectedIndex && this.focused;
      const itemRowCount = this.renderItem(
        item,
        i,
        isActive,
        width,
        numberWidth,
      ).length;
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
    numberWidth: number,
  ): string[] {
    const rowPrefix = this.buildRowPrefix(index, isActive, numberWidth);
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

  private buildRowPrefix(
    index: number,
    isActive: boolean,
    numberWidth: number,
  ): string {
    const pointer = isActive
      ? WrappingSelect.ACTIVE_POINTER
      : WrappingSelect.INACTIVE_POINTER;
    const displayNumber = this.numberStartOffset + index + 1;
    const paddedNumber = String(displayNumber).padStart(numberWidth, " ");
    return `${pointer}${paddedNumber}${WrappingSelect.NUMBER_SEPARATOR}`;
  }

  // Cursor as ECMA-48 SGR 7 reverse-video on the cell at the cursor (not an
  // inserted glyph). NBSP at end-of-buffer avoids wrapTextWithAnsi breaking
  // the line on the whitespace under the cursor. CURSOR_MARKER (zero-width)
  // positions the hardware cursor.
  private renderInlineInputRow(
    rowPrefix: string,
    continuationPrefix: string,
    contentWidth: number,
  ): string[] {
    const buffer = this.inputBuffer;
    const requested = this.inputCursorOffset;
    const offset =
      requested !== undefined && requested >= 0 && requested <= buffer.length
        ? requested
        : buffer.length;
    const before = buffer.slice(0, offset);
    const [firstGrapheme] = graphemeSegmenter.segment(buffer.slice(offset));
    const rawAt = firstGrapheme ? firstGrapheme.segment : "";
    const atCursor = rawAt === "" || rawAt === " " ? "\u00a0" : rawAt;
    const after = buffer.slice(offset + rawAt.length);
    const raw = `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
    const wrapped = wrapTextWithAnsi(raw, contentWidth);
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

// OptionListView — single-select option list (wraps one WrappingSelect).

export const MAX_VISIBLE_OPTIONS = 10;

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
    // Reserve a numbering slot for the chat row (items.length + 1) so the
    // number column width is stable whether or not chat is focused.
    this.select = new WrappingSelect(
      items,
      Math.min(items.length, MAX_VISIBLE_OPTIONS),
      theme,
      {
        numberStartOffset: 0,
        totalItemsForNumbering: items.length + 1,
      },
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

// MultiSelectView — checkbox list + Next/Submit sentinel.

export const MULTI_SUBMIT_LABEL = "Submit";

const MS_ACTIVE_POINTER = "❯ ";
const MS_INACTIVE_POINTER = "  ";
const MS_CHECKED = "[✔]";
const MS_UNCHECKED = "[ ]";
const MS_NUMBER_SEPARATOR = ". ";
const MS_BOX_LABEL_GAP = " ";
const MS_CONTINUATION_INDENT = "  ";

export interface MultiSelectViewProps {
  rows: ReadonlyArray<{ checked: boolean; active: boolean }>;
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
      nextActive: false,
      nextLabel: sentinelLabel("next"),
    };
  }

  setProps(props: MultiSelectViewProps): void {
    this.props = props;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const prefixWidth = this.prefixVisibleWidth();
    const contentWidth = Math.max(1, width - prefixWidth);
    const numberWidth = String(
      Math.max(1, this.question.options.length),
    ).length;
    for (let i = 0; i < this.question.options.length; i++) {
      const opt = this.question.options[i];
      const row = this.props.rows[i];
      if (!opt || !row) continue;
      const pointer = row.active
        ? this.theme.fg("accent", MS_ACTIVE_POINTER)
        : MS_INACTIVE_POINTER;
      const box = row.checked
        ? this.theme.fg("accent", MS_CHECKED)
        : this.theme.fg("muted", MS_UNCHECKED);
      const label = truncateToWidth(opt.label, contentWidth, "…");
      const styledLabel = row.active
        ? this.theme.fg("accent", this.theme.bold(label))
        : label;
      const num = String(i + 1).padStart(numberWidth, " ");
      const line = `${pointer}${num}${MS_NUMBER_SEPARATOR}${box}${MS_BOX_LABEL_GAP}${styledLabel}`;
      lines.push(truncateToWidth(line, width, ""));
      if (opt.description) {
        for (const segment of wrapTextWithAnsi(opt.description, contentWidth)) {
          lines.push(MS_CONTINUATION_INDENT + this.theme.fg("muted", segment));
        }
      }
    }
    const nextPointer = this.props.nextActive
      ? this.theme.fg("accent", MS_ACTIVE_POINTER)
      : MS_INACTIVE_POINTER;
    const nextLabel = this.props.nextActive
      ? this.theme.fg("accent", this.theme.bold(this.props.nextLabel))
      : this.props.nextLabel;
    lines.push(truncateToWidth(`${nextPointer}${nextLabel}`, width, ""));
    return lines;
  }

  focusedItemRowRange(width: number): [number, number] {
    const contentWidth = Math.max(1, width - this.prefixVisibleWidth());
    let row = 0;
    for (let i = 0; i < this.question.options.length; i++) {
      const opt = this.question.options[i];
      const r = this.props.rows[i];
      if (!opt || !r) continue;
      const itemHeight =
        1 +
        (opt.description
          ? wrapTextWithAnsi(opt.description, contentWidth).length
          : 0);
      if (r.active) return [row, row + itemHeight];
      row += itemHeight;
    }
    if (this.props.nextActive) return [row, row + 1];
    return [0, 0];
  }

  naturalHeight(width: number): number {
    const contentWidth = Math.max(1, width - this.prefixVisibleWidth());
    let total = 0;
    for (const opt of this.question.options) {
      if (!opt) continue;
      total += 1;
      if (opt.description)
        total += wrapTextWithAnsi(opt.description, contentWidth).length;
    }
    return total + 1; // Next sentinel row.
  }

  private prefixVisibleWidth(): number {
    const numberWidth = String(
      Math.max(1, this.question.options.length),
    ).length;
    return (
      visibleWidth(MS_INACTIVE_POINTER) +
      numberWidth +
      visibleWidth(`${MS_NUMBER_SEPARATOR}${MS_UNCHECKED}${MS_BOX_LABEL_GAP}`)
    );
  }
}

// ChatRowView — single-item WrappingSelect rendered in the footer.

export interface ChatRowViewProps {
  focused: boolean;
  numbering: { offset: number; total: number };
}

export class ChatRowView implements Component {
  private readonly select: WrappingSelect;

  constructor(item: WrappingSelectItem, theme: WrappingSelectTheme) {
    this.select = new WrappingSelect([item], 1, theme, {
      numberStartOffset: 0,
      totalItemsForNumbering: 1,
    });
  }

  setProps(props: ChatRowViewProps): void {
    this.select.setFocused(props.focused);
    this.select.setNumbering(props.numbering.offset, props.numbering.total);
  }

  handleInput(_data: string): void {}

  invalidate(): void {
    this.select.invalidate();
  }

  render(width: number): string[] {
    return this.select.render(width);
  }
}

// TabBar — one segment per question + a Submit segment.

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

// SubmitPicker — static 2-row Submit / Cancel picker on the Submit tab.

export const SUBMIT_LABEL = "Submit answers";
export const CANCEL_LABEL = "Cancel";

const SP_ACTIVE_POINTER = "❯ ";
const SP_INACTIVE_POINTER = "  ";
const SP_NUMBER_SEPARATOR = ". ";

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
      const number = `${i + 1}${SP_NUMBER_SEPARATOR}`;
      const label = active
        ? this.theme.fg("accent", this.theme.bold(text))
        : this.theme.fg("text", text);
      lines.push(truncateToWidth(`${pointer}${number}${label}`, width, ""));
    }
    return lines;
  }
}
