import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  Spacer,
  Text,
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
  MULTI_SUBMIT_LABEL,
  type MultiSelectViewProps,
  MultiSelectView,
  type OptionListViewProps,
  OptionListView,
  TabBar,
  type TabBarProps,
  type WrappingSelectItem,
  type WrappingSelectTheme,
} from "./widgets";
export const COLLAPSED_HINT = "Ctrl+] to expand · Esc to cancel";

function tabLabel(q: QuestionData, i: number): string {
  return q.header || `Q${i + 1}`;
}

function selectActiveTabIndex(
  currentTab: number,
  totalQuestions: number,
): number {
  if (totalQuestions <= 0) return 0;
  return Math.min(currentTab, totalQuestions - 1);
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
  if (!prior) return undefined;
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

function getInputCursorOffset(input: Input): number | undefined {
  const raw = (input as unknown as { cursor?: unknown }).cursor;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return undefined;
  if (raw < 0 || raw > input.getValue().length) return undefined;
  return raw;
}

interface TabComponents {
  optionList: OptionListView;
  multiSelect?: MultiSelectView;
  bodyHeight: (width: number) => number;
}

interface TabContentStrategy {
  headingRows(state: QuestionnaireState): Component[];
  bodyComponent(state: QuestionnaireState): Component;
  bodyHeight(width: number, state: QuestionnaireState): number;
  focusedItemRowRange(
    width: number,
    state: QuestionnaireState,
  ): [number, number] | undefined;
}

interface QuestionTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  getActiveOptionList: () => OptionListView;
  tabsByIndex: ReadonlyArray<TabComponents>;
  isMulti: boolean;
  getCurrentBodyHeight: (width: number) => number;
}

class QuestionTabStrategy implements TabContentStrategy {
  constructor(private readonly config: QuestionTabStrategyConfig) {}

  headingRows(state: QuestionnaireState): Component[] {
    const out: Component[] = [];
    const question = this.config.questions[state.currentTab];
    if (!this.config.isMulti && question?.header) {
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

  bodyComponent(state: QuestionnaireState): Component {
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (this.config.questions[state.currentTab]?.multiSelect === true && mso)
      return mso;
    return this.config.getActiveOptionList();
  }

  bodyHeight(width: number, _state: QuestionnaireState): number {
    return this.config.getCurrentBodyHeight(width);
  }

  focusedItemRowRange(
    width: number,
    state: QuestionnaireState,
  ): [number, number] | undefined {
    const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
    if (this.config.questions[state.currentTab]?.multiSelect === true && mso)
      return mso.focusedItemRowRange(width);
    return this.config.getActiveOptionList().focusedItemRowRange(width);
  }
}

interface SubmitTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
}

class SubmitTabStrategy implements TabContentStrategy {
  constructor(private readonly config: SubmitTabStrategyConfig) {}

  headingRows(_state: QuestionnaireState): Component[] {
    return [
      new Text(
        this.config.theme.bold(
          this.config.theme.fg("accent", "Review your answers"),
        ),
        1,
        0,
      ),
      new Spacer(1),
    ];
  }

  bodyComponent(state: QuestionnaireState): Component {
    const { theme, questions } = this.config;
    const c = new Container();
    const missing: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const label = tabLabel(questions[i]!, i);
      const a = state.answers.get(i);
      if (!a) {
        missing.push(label);
        continue;
      }
      c.addChild(new Text(theme.fg("muted", ` ● ${label}`), 1, 0));
      c.addChild(
        new Text(
          `   ${theme.fg("muted", "→")} ${theme.fg("text", formatAnswerScalar(a))}`,
          1,
          0,
        ),
      );
    }
    c.addChild(new Spacer(1));
    c.addChild(
      new Text(
        missing.length === 0
          ? theme.fg("accent", "→ Submit answers")
          : theme.fg(
              "warning",
              `⚠ Answer remaining questions before submitting: ${missing.join(", ")}`,
            ),
        1,
        0,
      ),
    );
    return c;
  }

  bodyHeight(width: number, state: QuestionnaireState): number {
    return this.bodyComponent(state).render(width).length;
  }

  focusedItemRowRange(
    _width: number,
    _state: QuestionnaireState,
  ): [number, number] | undefined {
    return undefined;
  }
}

interface DialogProps {
  state: QuestionnaireState;
  activeOptionList: OptionListView;
}

interface DialogConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  tabBar: TabBar | undefined;
  isMulti: boolean;
  tabsByIndex: ReadonlyArray<TabComponents>;
  getBodyHeight: (width: number) => number;
  getCurrentBodyHeight: (width: number) => number;
  getTerminalRows: () => number;
}

class DialogView {
  private liveProps: DialogProps;
  private readonly config: DialogConfig;
  private readonly questionStrategy: QuestionTabStrategy;
  private readonly submitStrategy: SubmitTabStrategy | undefined;

  constructor(config: DialogConfig, initialProps: DialogProps) {
    this.config = config;
    this.liveProps = initialProps;
    this.questionStrategy = new QuestionTabStrategy({
      theme: config.theme,
      questions: config.questions,
      getActiveOptionList: () => this.liveProps.activeOptionList,
      tabsByIndex: config.tabsByIndex,
      isMulti: config.isMulti,
      getCurrentBodyHeight: config.getCurrentBodyHeight,
    });
    this.submitStrategy = config.isMulti
      ? new SubmitTabStrategy({
          theme: config.theme,
          questions: config.questions,
        })
      : undefined;
  }

  setProps(props: DialogProps): void {
    this.liveProps = props;
  }

  render(width: number): string[] {
    const state = this.liveProps.state;
    const strategy =
      this.config.isMulti &&
      state.currentTab === this.config.questions.length &&
      this.submitStrategy
        ? this.submitStrategy
        : this.questionStrategy;

    const headingRowCache = strategy.headingRows(state);
    const natural = this.buildContainerFromStrategy(
      strategy,
      headingRowCache,
    ).render(width);

    const topFixed =
      1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
    const bottomFixed = 1;
    const middleRows = natural.length - topFixed - bottomFixed;

    const spacerRows = Math.max(
      0,
      this.config.getBodyHeight(width) - strategy.bodyHeight(width, state),
    );

    const termRows = this.config.getTerminalRows();

    if (natural.length + spacerRows <= termRows) {
      return spacerRows > 0
        ? [...natural, ...Array<string>(spacerRows).fill("")]
        : natural;
    }

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
      scrollStart = Math.max(
        0,
        Math.min(
          headingRowCache.length +
            bodyRange[0] -
            Math.floor(
              Math.max(0, availableMiddle - (bodyRange[1] - bodyRange[0])) / 2,
            ),
          middleRows - availableMiddle,
        ),
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
      scrollableMiddle[0] = this.config.theme.fg("dim", "↕");
    } else {
      if (hasUp && scrollableMiddle.length > 0)
        scrollableMiddle[0] = this.config.theme.fg("dim", "↑");
      if (hasDown && scrollableMiddle.length > 0) {
        scrollableMiddle[scrollableMiddle.length - 1] = this.config.theme.fg(
          "dim",
          "↓",
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

    return container;
  }
}

export class QuestionnairePropsAdapter {
  constructor(
    private readonly tui: { requestRender(): void },
    private readonly questions: readonly QuestionData[],
    private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
    private readonly tabsByIndex: ReadonlyArray<TabComponents>,
    private readonly inlineInput: Input,
    private readonly dialog: DialogView,
    private readonly tabBar: TabBar | undefined,
  ) {}

  apply(state: QuestionnaireState): void {
    const totalQuestions = this.questions.length;
    const activeView: ActiveView = selectActiveView(state, totalQuestions);
    const tabIndex = selectActiveTabIndex(state.currentTab, totalQuestions);
    const inputCursorOffset = getInputCursorOffset(this.inlineInput);

    this.dialog.setProps({
      state,
      activeOptionList:
        this.tabsByIndex[tabIndex]?.optionList ??
        this.tabsByIndex[0]!.optionList,
    });

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
        const confirmed = selectConfirmedIndicator(
          this.questions,
          state.currentTab,
          state.answers,
          this.itemsByTab[i] ?? [],
        );
        tab.optionList.setProps({
          selectedIndex: state.optionIndex,
          focused: activeView === "options",
          inputBuffer: this.inlineInput.getValue(),
          inputCursorOffset,
          ...(confirmed ? { confirmed } : {}),
        } satisfies OptionListViewProps);
      }
      if (tab.multiSelect) {
        tab.multiSelect.setProps(
          this.multiSelectProps(state, i, activeView, inputCursorOffset),
        );
      }
    }

    this.tui.requestRender();
  }

  private multiSelectProps(
    state: QuestionnaireState,
    i: number,
    activeView: ActiveView,
    inputCursorOffset: number | undefined,
  ): MultiSelectViewProps {
    const question = this.questions[i];
    if (!question)
      return {
        rows: [],
        other: { active: false, text: "" },
        nextActive: false,
        nextLabel: ROW_INTENT_META.next.label,
      };
    const focused = activeView === "options" && i === state.currentTab;
    const focusedKind = focused
      ? this.itemsByTab[i]?.[state.optionIndex]?.kind
      : undefined;
    const rows: { checked: boolean; active: boolean }[] = [];
    for (let j = 0; j < question.options.length; j++) {
      rows.push({
        checked: state.multiSelectChecked.has(j),
        active: focused && j === state.optionIndex,
      });
    }
    return {
      rows,
      other:
        focusedKind === "other"
          ? {
              active: true,
              text: this.inlineInput.getValue(),
              cursorOffset: inputCursorOffset,
            }
          : { active: false, text: state.answers.get(i)?.custom ?? "" },
      nextActive: focusedKind === "next",
      nextLabel:
        i === this.questions.length - 1
          ? MULTI_SUBMIT_LABEL
          : ROW_INTENT_META.next.label,
    };
  }

  invalidate(): void {
    this.tabBar?.invalidate();
    for (const tab of this.tabsByIndex) {
      tab.optionList.invalidate();
      tab.multiSelect?.invalidate();
    }
  }
}

interface QuestionnaireBuildConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
  isMulti: boolean;
  initialState: QuestionnaireState;
  getCurrentTab: () => number;
}

interface QuestionnaireBuilt {
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

  const inlineInput = new Input();

  const tabsByIndex: TabComponents[] = questions.map((question, index) => {
    const optionList = new OptionListView(itemsByTab[index] ?? [], {
      selectedText: (s) => theme.fg("accent", s),
      description: (s) => theme.fg("muted", s),
      scrollInfo: (s) => theme.fg("dim", s),
    } satisfies WrappingSelectTheme);
    const multiSelect = question.multiSelect
      ? new MultiSelectView(theme, question)
      : undefined;
    return {
      optionList,
      multiSelect,
      bodyHeight: (width: number): number =>
        multiSelect
          ? multiSelect.naturalHeight(width)
          : optionList.naturalHeight(width),
    };
  });

  const tabBar = isMulti ? new TabBar(theme) : undefined;
  const dialog = new DialogView(
    {
      theme,
      questions,
      tabBar,
      isMulti,
      tabsByIndex,
      getBodyHeight: (width: number): number => {
        let max = 0;
        for (const tab of tabsByIndex) {
          const h = tab.bodyHeight(width);
          if (h > max) max = h;
        }
        return Math.max(1, max);
      },
      getCurrentBodyHeight: (width: number): number => {
        return Math.max(
          0,
          tabsByIndex[
            Math.min(getCurrentTab(), tabsByIndex.length - 1)
          ]?.bodyHeight(width) ?? 0,
        );
      },
      getTerminalRows: () => tui.terminal.rows,
    },
    {
      state: initialState,
      activeOptionList:
        tabsByIndex[
          selectActiveTabIndex(initialState.currentTab, questions.length)
        ]?.optionList ?? tabsByIndex[0]!.optionList,
    },
  );

  const adapter = new QuestionnairePropsAdapter(
    tui,
    questions,
    itemsByTab,
    tabsByIndex,
    inlineInput,
    dialog,
    tabBar,
  );

  return {
    adapter,
    inlineInput,
    render: (w) => dialog.render(w),
    invalidate: () => adapter.invalidate(),
  };
}
