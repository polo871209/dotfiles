// View assembly + the bordered dialog itself.
//
//   buildQuestionnaire()         — constructs every component + the adapter
//   QuestionnairePropsAdapter    — fans canonical state out to components each tick
//   DialogView                   — borders, tab bar, body, footer, overflow scroll
//   {Question,Submit}TabStrategy — per-tab body/heading/footer content

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  type QuestionAnswer,
  type QuestionData,
  formatAnswerScalar,
  ROW_INTENT_META,
} from "./schema";
import {
  type ActiveView,
  type QuestionnaireState,
  selectActiveView,
} from "./session";
import {
  ChatRowView,
  MULTI_SUBMIT_LABEL,
  type MultiSelectViewProps,
  MultiSelectView,
  type OptionListViewProps,
  OptionListView,
  SubmitPicker,
  type SubmitPickerProps,
  TabBar,
  type TabBarProps,
  type WrappingSelectItem,
  type WrappingSelectTheme,
} from "./widgets";

// Hint strings

const HINT_PART_ENTER = "Enter to select";
const HINT_PART_NAV = "↑/↓ to navigate";
const HINT_PART_TOGGLE = "Space to toggle";
const HINT_PART_TAB = "Tab to switch questions";
const HINT_PART_CANCEL = "Esc to cancel";
const HINT_PART_COLLAPSE = "Ctrl+] to collapse";
const HINT_PART_EXPAND = "Ctrl+] to expand";
export const COLLAPSED_HINT = [HINT_PART_EXPAND, HINT_PART_CANCEL].join(" · ");
const REVIEW_HEADING = "Review your answers";
const READY_PROMPT = "Ready to submit your answers?";
const INCOMPLETE_WARNING_PREFIX =
  "⚠ Answer remaining questions before submitting:";

function tabLabel(q: QuestionData, i: number): string {
  return q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
}

function buildHintText(
  question: QuestionData | undefined,
  isMulti: boolean,
): string {
  const parts: string[] = [HINT_PART_ENTER, HINT_PART_NAV];
  if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
  if (isMulti) parts.push(HINT_PART_TAB);
  parts.push(HINT_PART_CANCEL);
  parts.push(HINT_PART_COLLAPSE);
  return parts.join(" · ");
}

// Derivations (formerly state/selectors)

function selectActiveTabIndex(
  currentTab: number,
  totalQuestions: number,
): number {
  if (totalQuestions <= 0) return 0;
  return Math.min(currentTab, totalQuestions - 1);
}

function selectActiveTabItems(
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
  currentTab: number,
  totalQuestions: number,
): readonly WrappingSelectItem[] {
  return itemsByTab[selectActiveTabIndex(currentTab, totalQuestions)] ?? [];
}

function chatNumberingFor(items: readonly WrappingSelectItem[]): {
  offset: number;
  total: number;
} {
  const count = items.filter((i) => ROW_INTENT_META[i.kind].numbered).length;
  return { offset: count, total: count + 1 };
}

function selectConfirmedIndicator(
  questions: readonly QuestionData[],
  currentTab: number,
  answers: ReadonlyMap<number, QuestionAnswer>,
  items: readonly WrappingSelectItem[],
): { index: number; labelOverride?: string } | undefined {
  const q = questions[currentTab];
  if (!q || q.multiSelect === true) return undefined;
  const prior = answers.get(currentTab);
  if (!prior || prior.kind === "chat") return undefined;
  if (prior.kind === "custom") {
    const otherIndex = items.findIndex((it) => it.kind === "other");
    if (otherIndex < 0) return undefined;
    return { index: otherIndex, labelOverride: prior.answer ?? "" };
  }
  if (prior.kind !== "option" || typeof prior.answer !== "string")
    return undefined;
  const index = items.findIndex(
    (it) => it.kind === "option" && it.label === prior.answer,
  );
  if (index < 0) return undefined;
  return { index };
}

// Reads pi-tui Input's private cursor with runtime validation; undefined → end-of-buffer.
function getInputCursorOffset(input: Input): number | undefined {
  const raw = (input as unknown as { cursor?: unknown }).cursor;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return undefined;
  const value = input.getValue();
  if (raw < 0 || raw > value.length) return undefined;
  return raw;
}

// Tab components + strategies

interface TabComponents {
  optionList: OptionListView;
  multiSelect?: MultiSelectView;
  bodyHeight: (width: number) => number;
}

type DialogState = QuestionnaireState;

interface TabContentStrategy {
  readonly footerRowCount: number;
  headingRows(state: DialogState): Component[];
  bodyComponent(state: DialogState): Component;
  bodyHeight(width: number, state: DialogState): number;
  footerRows(state: DialogState): Component[];
  focusedItemRowRange(
    width: number,
    state: DialogState,
  ): [number, number] | undefined;
}

// Single-row width-clipped chrome cell: keeps the hint on one line so the
// strategy's footerRowCount invariant holds; the collapse affordance clips
// with "…" on narrow terminals.
class OneLineClippedText implements Component {
  constructor(
    private readonly text: string,
    private readonly paddingLeft = 0,
  ) {}

  render(width: number): string[] {
    const pad = " ".repeat(this.paddingLeft);
    return [
      pad +
        truncateToWidth(
          this.text,
          Math.max(0, width - this.paddingLeft),
          "…",
          false,
        ),
    ];
  }

  invalidate(): void {}

  handleInput(_data: string): void {}
}

interface QuestionTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  getActiveOptionList: () => OptionListView;
  tabsByIndex: ReadonlyArray<TabComponents>;
  chatRow: ChatRowView;
  isMulti: boolean;
  getCurrentBodyHeight: (width: number) => number;
}

class QuestionTabStrategy implements TabContentStrategy {
  readonly footerRowCount = 4; // Spacer + chatRow + Spacer + hint

  constructor(private readonly config: QuestionTabStrategyConfig) {}

  headingRows(state: DialogState): Component[] {
    const out: Component[] = [];
    const question = this.config.questions[state.currentTab];
    if (
      !this.config.isMulti &&
      question?.header &&
      question.header.length > 0
    ) {
      out.push(
        new Text(
          this.config.theme.bg("selectedBg", ` ${question.header} `),
          1,
          0,
        ),
      );
      out.push(new Spacer(1));
    }
    if (question) {
      out.push(new Text(this.config.theme.bold(question.question), 1, 0));
      out.push(new Spacer(1));
    }
    return out;
  }

  bodyComponent(state: DialogState): Component {
    const question = this.config.questions[state.currentTab];
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && mso) return mso;
    return this.config.getActiveOptionList();
  }

  bodyHeight(width: number, _state: DialogState): number {
    return this.config.getCurrentBodyHeight(width);
  }

  footerRows(state: DialogState): Component[] {
    const question = this.config.questions[state.currentTab];
    return [
      new Spacer(1),
      this.config.chatRow,
      new Spacer(1),
      new OneLineClippedText(
        this.config.theme.fg(
          "dim",
          buildHintText(question, this.config.isMulti),
        ),
        1,
      ),
    ];
  }

  focusedItemRowRange(
    width: number,
    state: DialogState,
  ): [number, number] | undefined {
    const question = this.config.questions[state.currentTab];
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (question?.multiSelect === true && mso)
      return mso.focusedItemRowRange(width);
    return this.config.getActiveOptionList().focusedItemRowRange(width);
  }
}

interface SubmitTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  submitPicker: Component | undefined;
}

class SubmitTabStrategy implements TabContentStrategy {
  readonly footerRowCount = 5; // Spacer + prompt + Spacer + picker(2)

  constructor(private readonly config: SubmitTabStrategyConfig) {}

  headingRows(_state: DialogState): Component[] {
    return [
      new Text(
        this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)),
        1,
        0,
      ),
      new Spacer(1),
    ];
  }

  bodyComponent(state: DialogState): Component {
    const c = new Container();
    for (let i = 0; i < this.config.questions.length; i++) {
      const q = this.config.questions[i]!;
      const a = state.answers.get(i);
      if (!a) continue;
      const answerText = formatAnswerScalar(a, "summary");
      c.addChild(
        new Text(this.config.theme.fg("muted", ` ● ${tabLabel(q, i)}`), 1, 0),
      );
      c.addChild(
        new Text(
          `   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`,
          1,
          0,
        ),
      );
    }
    return c;
  }

  bodyHeight(width: number, state: DialogState): number {
    return this.bodyComponent(state).render(width).length;
  }

  footerRows(state: DialogState): Component[] {
    const missing: string[] = [];
    for (let i = 0; i < this.config.questions.length; i++) {
      if (!state.answers.has(i))
        missing.push(tabLabel(this.config.questions[i]!, i));
    }
    const promptText =
      missing.length === 0
        ? this.config.theme.fg("muted", READY_PROMPT)
        : this.config.theme.fg(
            "warning",
            `${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`,
          );
    const out: Component[] = [
      new Spacer(1),
      new Text(promptText, 1, 0),
      new Spacer(1),
    ];
    if (this.config.submitPicker) {
      out.push(this.config.submitPicker);
    } else {
      out.push(new Spacer(1));
      out.push(new Spacer(1));
    }
    return out;
  }

  focusedItemRowRange(
    _width: number,
    _state: DialogState,
  ): [number, number] | undefined {
    return undefined;
  }
}

// DialogView

export interface DialogProps {
  state: DialogState;
  activeOptionList: OptionListView;
}

interface DialogConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  tabBar: TabBar | undefined;
  chatRow: ChatRowView;
  isMulti: boolean;
  tabsByIndex: ReadonlyArray<TabComponents>;
  submitPicker?: Component;
  getBodyHeight: (width: number) => number;
  getCurrentBodyHeight: (width: number) => number;
  getTerminalRows: () => number;
}

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

class DialogView {
  private liveProps: DialogProps;
  private readonly config: DialogConfig;
  private readonly questionStrategy: QuestionTabStrategy;
  private readonly submitStrategy: SubmitTabStrategy | undefined;
  private readonly maxFooterRowCount: number;

  constructor(config: DialogConfig, initialProps: DialogProps) {
    this.config = config;
    this.liveProps = initialProps;
    this.questionStrategy = new QuestionTabStrategy({
      theme: config.theme,
      questions: config.questions,
      getActiveOptionList: () => this.liveProps.activeOptionList,
      tabsByIndex: config.tabsByIndex,
      chatRow: config.chatRow,
      isMulti: config.isMulti,
      getCurrentBodyHeight: config.getCurrentBodyHeight,
    });
    this.submitStrategy = config.isMulti
      ? new SubmitTabStrategy({
          theme: config.theme,
          questions: config.questions,
          submitPicker: config.submitPicker,
        })
      : undefined;
    this.maxFooterRowCount = Math.max(
      this.questionStrategy.footerRowCount,
      this.submitStrategy?.footerRowCount ?? 0,
    );
  }

  setProps(props: DialogProps): void {
    this.liveProps = props;
  }

  render(width: number): string[] {
    const state = this.liveProps.state;
    const onSubmit =
      this.config.isMulti && state.currentTab === this.config.questions.length;
    const strategy =
      onSubmit && this.submitStrategy
        ? this.submitStrategy
        : this.questionStrategy;

    const headingRowCache = strategy.headingRows(state);
    const headingCount = headingRowCache.length;
    const natural = this.buildContainerFromStrategy(
      strategy,
      headingRowCache,
    ).render(width);

    // TabBar.render() returns [tabLine, ""] — always 2 rows.
    const topFixed =
      1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
    const bottomFixed = 1 + strategy.footerRowCount;
    const middleRows = natural.length - topFixed - bottomFixed;

    const spacerRows = Math.max(
      0,
      this.config.getBodyHeight(width) +
        this.maxFooterRowCount -
        strategy.bodyHeight(width, state) -
        strategy.footerRowCount,
    );

    const termRows = this.config.getTerminalRows();

    if (natural.length + spacerRows <= termRows) {
      return spacerRows > 0
        ? [...natural, ...Array<string>(spacerRows).fill("")]
        : natural;
    }

    // Overflow: 3-region partition with scroll-to-focus.
    const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
    if (availableMiddle === 0) {
      const chromeOnly = [
        ...natural.slice(0, topFixed),
        ...natural.slice(natural.length - bottomFixed),
      ];
      return chromeOnly.length > termRows
        ? chromeOnly.slice(0, termRows)
        : chromeOnly;
    }

    const bodyRange = strategy.focusedItemRowRange(width, state);
    let scrollStart: number;
    if (bodyRange) {
      const focusedRowInMiddle = headingCount + bodyRange[0];
      const focusedHeight = bodyRange[1] - bodyRange[0];
      const idealStart =
        focusedRowInMiddle -
        Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
      scrollStart = Math.max(
        0,
        Math.min(idealStart, middleRows - availableMiddle),
      );
    } else {
      scrollStart = 0;
    }

    const scrollableMiddle = natural.slice(
      topFixed + scrollStart,
      topFixed + scrollStart + availableMiddle,
    );

    const hasUp = scrollStart > 0;
    const hasDown = scrollStart + availableMiddle < middleRows;
    if (hasUp && hasDown && scrollableMiddle.length === 1) {
      scrollableMiddle[0] = this.config.theme.fg("dim", OVERFLOW_BOTH);
    } else {
      if (hasUp && scrollableMiddle.length > 0)
        scrollableMiddle[0] = this.config.theme.fg("dim", OVERFLOW_UP);
      if (hasDown && scrollableMiddle.length > 0) {
        scrollableMiddle[scrollableMiddle.length - 1] = this.config.theme.fg(
          "dim",
          OVERFLOW_DOWN,
        );
      }
    }

    const result = [
      ...natural.slice(0, topFixed),
      ...scrollableMiddle,
      ...natural.slice(natural.length - bottomFixed),
    ];
    return result.length > termRows ? result.slice(0, termRows) : result;
  }

  private buildContainerFromStrategy(
    strategy: TabContentStrategy,
    headingRowCache: Component[],
  ): Container {
    const { theme, isMulti, tabBar } = this.config;
    const state = this.liveProps.state;
    const container = new Container();
    const border = () => new DynamicBorder((s) => theme.fg("accent", s));

    container.addChild(border());
    if (isMulti && tabBar) container.addChild(tabBar);
    container.addChild(new Spacer(1));

    for (const c of headingRowCache) container.addChild(c);
    container.addChild(strategy.bodyComponent(state));
    container.addChild(new Spacer(1));

    container.addChild(border());
    for (const c of strategy.footerRows(state)) container.addChild(c);

    return container;
  }
}

// Props adapter: state → component props each tick

export class QuestionnairePropsAdapter {
  constructor(
    private readonly tui: { requestRender(): void },
    private readonly questions: readonly QuestionData[],
    private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
    private readonly tabsByIndex: ReadonlyArray<TabComponents>,
    private readonly inlineInput: Input,
    private readonly dialog: DialogView,
    private readonly chatRow: ChatRowView,
    private readonly submitPicker: SubmitPicker | undefined,
    private readonly tabBar: TabBar | undefined,
  ) {}

  apply(state: QuestionnaireState): void {
    const totalQuestions = this.questions.length;
    const activeView: ActiveView = selectActiveView(state, totalQuestions);
    const tabIndex = selectActiveTabIndex(state.currentTab, totalQuestions);
    const activeOptionList =
      this.tabsByIndex[tabIndex]?.optionList ?? this.tabsByIndex[0]!.optionList;
    const inputBuffer = this.inlineInput.getValue();
    const inputCursorOffset = getInputCursorOffset(this.inlineInput);

    this.dialog.setProps({ state, activeOptionList });

    const activeItems = selectActiveTabItems(
      this.itemsByTab,
      state.currentTab,
      totalQuestions,
    );
    this.chatRow.setProps({
      focused: activeView === "chat",
      numbering: chatNumberingFor(activeItems),
    });

    if (this.submitPicker) {
      const focused = activeView === "submit";
      this.submitPicker.setProps({
        rows: [
          { active: focused && state.submitChoiceIndex === 0 },
          { active: focused && state.submitChoiceIndex === 1 },
        ],
      } satisfies SubmitPickerProps);
    }

    if (this.tabBar) {
      this.tabBar.setProps({
        tabs: this.questions.map((q, i) => ({
          label: tabLabel(q, i),
          answered: state.answers.has(i),
          active: i === state.currentTab,
        })),
        submit: {
          active: state.currentTab === totalQuestions,
          allAnswered:
            state.answers.size === totalQuestions && totalQuestions > 0,
        },
      } satisfies TabBarProps);
    }

    for (let i = 0; i < this.tabsByIndex.length; i++) {
      const tab = this.tabsByIndex[i]!;
      if (i === tabIndex) {
        const items = this.itemsByTab[i] ?? [];
        const confirmed = selectConfirmedIndicator(
          this.questions,
          state.currentTab,
          state.answers,
          items,
        );
        tab.optionList.setProps({
          selectedIndex: state.optionIndex,
          focused: activeView === "options",
          inputBuffer,
          inputCursorOffset,
          ...(confirmed ? { confirmed } : {}),
        } satisfies OptionListViewProps);
      }
      if (tab.multiSelect) {
        tab.multiSelect.setProps(this.multiSelectProps(state, i, activeView));
      }
    }

    this.tui.requestRender();
  }

  private multiSelectProps(
    state: QuestionnaireState,
    i: number,
    activeView: ActiveView,
  ): MultiSelectViewProps {
    const question = this.questions[i];
    if (!question)
      return {
        rows: [],
        nextActive: false,
        nextLabel: ROW_INTENT_META.next.label,
      };
    const focused = activeView === "options" && i === state.currentTab;
    const rows: { checked: boolean; active: boolean }[] = [];
    for (let j = 0; j < question.options.length; j++) {
      rows.push({
        checked: state.multiSelectChecked.has(j),
        active: focused && j === state.optionIndex,
      });
    }
    const nextActive = focused && state.optionIndex === question.options.length;
    const nextLabel =
      i === this.questions.length - 1
        ? MULTI_SUBMIT_LABEL
        : ROW_INTENT_META.next.label;
    return { rows, nextActive, nextLabel };
  }

  invalidate(): void {
    // DialogView rebuilds its container every render — nothing to invalidate there.
    this.chatRow.invalidate();
    this.tabBar?.invalidate();
    this.submitPicker?.invalidate();
    for (const tab of this.tabsByIndex) {
      tab.optionList.invalidate();
      tab.multiSelect?.invalidate();
    }
  }
}

// Builder

export interface QuestionnaireBuildConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  isMulti: boolean;
  initialState: QuestionnaireState;
  getCurrentTab: () => number;
}

export interface QuestionnaireBuilt {
  adapter: QuestionnairePropsAdapter;
  inlineInput: Input;
  render: (width: number) => string[];
  invalidate: () => void;
}

export function buildQuestionnaire(
  config: QuestionnaireBuildConfig,
): QuestionnaireBuilt {
  const {
    tui,
    theme,
    questions,
    itemsByTab,
    isMulti,
    initialState,
    getCurrentTab,
  } = config;
  const getTerminalRows = () => tui.terminal.rows;

  const selectTheme: WrappingSelectTheme = {
    selectedText: (s) => theme.fg("accent", theme.bold(s)),
    description: (s) => theme.fg("muted", s),
    scrollInfo: (s) => theme.fg("dim", s),
  };

  const inlineInput = new Input();

  // Tabs
  const tabsByIndex: TabComponents[] = questions.map((question, index) => {
    const optionList = new OptionListView(itemsByTab[index] ?? [], selectTheme);
    const multiSelect = question.multiSelect
      ? new MultiSelectView(theme, question)
      : undefined;
    const bodyHeight = (width: number): number =>
      multiSelect
        ? multiSelect.naturalHeight(width)
        : optionList.naturalHeight(width);
    return { optionList, multiSelect, bodyHeight };
  });

  const submitPicker = isMulti ? new SubmitPicker(theme) : undefined;
  const tabBar = isMulti ? new TabBar(theme) : undefined;
  const chatRow = new ChatRowView(
    { kind: "chat", label: ROW_INTENT_META.chat.label },
    selectTheme,
  );

  const getBodyHeight = (width: number): number => {
    let max = 0;
    for (const tab of tabsByIndex) {
      const h = tab.bodyHeight(width);
      if (h > max) max = h;
    }
    return Math.max(1, max);
  };
  const getCurrentBodyHeight = (width: number): number => {
    const idx = Math.min(getCurrentTab(), tabsByIndex.length - 1);
    return Math.max(0, tabsByIndex[idx]?.bodyHeight(width) ?? 0);
  };

  const initialTabIndex = selectActiveTabIndex(
    initialState.currentTab,
    questions.length,
  );
  const dialog = new DialogView(
    {
      theme,
      questions,
      tabBar,
      chatRow,
      isMulti,
      tabsByIndex,
      submitPicker,
      getBodyHeight,
      getCurrentBodyHeight,
      getTerminalRows,
    },
    {
      state: initialState,
      activeOptionList:
        tabsByIndex[initialTabIndex]?.optionList ?? tabsByIndex[0]!.optionList,
    },
  );

  const adapter = new QuestionnairePropsAdapter(
    tui,
    questions,
    itemsByTab,
    tabsByIndex,
    inlineInput,
    dialog,
    chatRow,
    submitPicker,
    tabBar,
  );

  return {
    adapter,
    inlineInput,
    render: (w) => dialog.render(w),
    invalidate: () => adapter.invalidate(),
  };
}
