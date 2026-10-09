import {
  getKeybindings,
  type Input,
  Key,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  type QuestionParams,
  ROW_INTENT_META,
  sentinelLabel,
  sentinelsToAppend,
} from "./schema";
import {
  buildQuestionnaire,
  COLLAPSED_HINT,
  type QuestionnairePropsAdapter,
} from "./dialog";
import type { WrappingSelectItem } from "./widgets";

export interface QuestionnaireState {
  currentTab: number;
  optionIndex: number;
  inputMode: boolean;
  answers: ReadonlyMap<number, QuestionAnswer>;
  multiSelectChecked: ReadonlySet<number>;
  submitChoiceIndex: number;
  collapsed: boolean;
}

interface QuestionnaireRuntime {
  keybindings: { matches(data: string, name: string): boolean };
  inputBuffer: string;
  questions: readonly QuestionData[];
  isMulti: boolean;
  currentItem: WrappingSelectItem | undefined;
  items: readonly WrappingSelectItem[];
}

export type ActiveView = "options" | "submit";

export function selectActiveView(
  state: { currentTab: number },
  totalQuestions: number,
): ActiveView {
  return state.currentTab === totalQuestions ? "submit" : "options";
}

export function buildItemsForQuestion(
  question: QuestionData,
): WrappingSelectItem[] {
  const items: WrappingSelectItem[] = question.options.map((o) => ({
    kind: "option",
    label: o.label,
    description: o.description,
  }));
  for (const kind of sentinelsToAppend(question)) {
    items.push({ kind, label: sentinelLabel(kind) });
  }
  return items;
}

type QuestionnaireAction =
  | { kind: "nav"; nextIndex: number }
  | { kind: "tab_switch"; nextTab: number }
  | { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
  | { kind: "toggle"; index: number }
  | { kind: "multi_confirm"; autoAdvanceTab?: number }
  | { kind: "custom_text"; text: string }
  | { kind: "cancel" }
  | { kind: "submit" }
  | { kind: "submit_nav"; nextIndex: 0 | 1 }
  | { kind: "toggle_collapsed" }
  | { kind: "ignore" };

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

function wrapTab(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
  return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): number | undefined {
  if (!runtime.isMulti) return undefined;
  if (state.currentTab < runtime.questions.length - 1)
    return state.currentTab + 1;
  return runtime.questions.length;
}

function buildSingleSelectAnswer(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionAnswer | null {
  const q = runtime.questions[state.currentTab];
  if (!q) return null;

  const item = runtime.currentItem;
  if (state.inputMode) {
    const label = runtime.inputBuffer;
    return {
      questionIndex: state.currentTab,
      question: q.question,
      kind: "custom",
      answer: label.length > 0 ? label : null,
    };
  }
  if (!item) return null;
  if (item.kind === "other" || item.kind === "next") return null;
  return {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "option",
    answer: item.label,
  };
}

function tabSwitchAction(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
  if (!runtime.isMulti) return null;
  const total = totalTabs(runtime);
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
    return {
      kind: "tab_switch",
      nextTab: wrapTab(state.currentTab + 1, total),
    };
  }
  if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
    return {
      kind: "tab_switch",
      nextTab: wrapTab(state.currentTab - 1, total),
    };
  }
  return null;
}

function navAction(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
  const kb = runtime.keybindings;
  const delta = kb.matches(data, KEYBIND_DOWN)
    ? 1
    : kb.matches(data, KEYBIND_UP)
      ? -1
      : 0;
  if (delta === 0) return null;
  return {
    kind: "nav",
    nextIndex: wrapTab(
      state.optionIndex + delta,
      Math.max(1, runtime.items.length),
    ),
  };
}

function routeKey(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  const kb = runtime.keybindings;

  if (matchesKey(data, Key.ctrl("]"))) return { kind: "toggle_collapsed" };

  if (state.collapsed) {
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    return { kind: "ignore" };
  }

  if (state.inputMode) {
    if (
      kb.matches(data, KEYBIND_CONFIRM) &&
      runtime.questions[state.currentTab]?.multiSelect
    ) {
      return {
        kind: "multi_confirm",
        autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
      };
    }
    if (kb.matches(data, KEYBIND_CONFIRM)) {
      const answer = buildSingleSelectAnswer(state, runtime);
      if (!answer) return { kind: "ignore" };
      return {
        kind: "confirm",
        answer,
        autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
      };
    }
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    return navAction(data, state, runtime) ?? { kind: "ignore" };
  }

  if (runtime.isMulti && state.currentTab === runtime.questions.length) {
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    const tab = tabSwitchAction(data, state, runtime);
    if (tab) return tab;
    if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
      return {
        kind: "submit_nav",
        nextIndex: (wrapTab(
          state.submitChoiceIndex + (kb.matches(data, KEYBIND_DOWN) ? 1 : -1),
          2,
        ) === 1
          ? 1
          : 0) as 0 | 1,
      };
    }
    if (kb.matches(data, KEYBIND_CONFIRM)) {
      return state.submitChoiceIndex === 1
        ? { kind: "cancel" }
        : { kind: "submit" };
    }
    return { kind: "ignore" };
  }

  const tab = tabSwitchAction(data, state, runtime);
  if (tab) return tab;

  const q = runtime.questions[state.currentTab];
  if (!q) return { kind: "ignore" };

  const nav = navAction(data, state, runtime);
  if (nav) return nav;

  if (q.multiSelect) {
    const focusedKind = runtime.currentItem?.kind;
    const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
    if (data === " ") {
      if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
      return { kind: "toggle", index: state.optionIndex };
    }
    if (kb.matches(data, KEYBIND_CONFIRM)) {
      if (!focusedMeta?.autoSubmitsInMulti)
        return { kind: "toggle", index: state.optionIndex };
      return {
        kind: "multi_confirm",
        autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
      };
    }
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    return { kind: "ignore" };
  }

  if (kb.matches(data, KEYBIND_CONFIRM)) {
    const answer = buildSingleSelectAnswer(state, runtime);
    if (!answer) return { kind: "ignore" };
    return {
      kind: "confirm",
      answer,
      autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
    };
  }
  if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
  return { kind: "ignore" };
}

type Effect =
  | { kind: "set_input_buffer"; value: string }
  | { kind: "clear_input_buffer" }
  | { kind: "done"; result: QuestionnaireResult };

interface ApplyContext {
  questions: readonly QuestionData[];
  itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
}

interface ApplyResult {
  state: QuestionnaireState;
  effects: readonly Effect[];
}

function orderedAnswers(
  state: QuestionnaireState,
  questions: readonly QuestionData[],
): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = state.answers.get(i);
    if (a) out.push(a);
  }
  return out;
}

function syncMultiSelectFromAnswers(
  answers: ReadonlyMap<number, QuestionAnswer>,
  questions: readonly QuestionData[],
  tab: number,
): ReadonlySet<number> {
  const q = questions[tab];
  if (!q?.multiSelect) return new Set();
  const indices = new Set<number>();
  for (let i = 0; i < q.options.length; i++) {
    if ((answers.get(tab)?.selected ?? []).includes(q.options[i]!.label))
      indices.add(i);
  }
  return indices;
}

function buildMultiSelectAnswer(
  state: QuestionnaireState,
  q: QuestionData,
  custom: string | undefined,
): QuestionAnswer {
  return {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "multi",
    answer: null,
    selected: q.options
      .filter((_, i) => state.multiSelectChecked.has(i))
      .map((o) => o.label),
    ...(custom && custom.trim().length > 0 ? { custom } : {}),
  };
}

function persistMultiSelectAnswer(
  state: QuestionnaireState,
  ctx: ApplyContext,
  custom: string | undefined,
): ReadonlyMap<number, QuestionAnswer> {
  const q = ctx.questions[state.currentTab];
  if (!q?.multiSelect) return state.answers;
  const answer = buildMultiSelectAnswer(state, q, custom);
  const out = new Map(state.answers);
  if (answer.selected?.length === 0 && answer.custom === undefined)
    out.delete(state.currentTab);
  else out.set(state.currentTab, answer);
  return out;
}

function switchTabResult(
  state: QuestionnaireState,
  nextTab: number,
  ctx: ApplyContext,
): ApplyResult {
  return {
    state: {
      ...state,
      currentTab: nextTab,
      optionIndex: 0,
      inputMode: false,
      submitChoiceIndex: 0,
      multiSelectChecked: syncMultiSelectFromAnswers(
        state.answers,
        ctx.questions,
        nextTab,
      ),
    } satisfies QuestionnaireState,
    effects: [],
  };
}

function doneFor(
  state: QuestionnaireState,
  ctx: ApplyContext,
  cancelled: boolean,
): ApplyResult {
  return {
    state,
    effects: [
      {
        kind: "done",
        result: { answers: orderedAnswers(state, ctx.questions), cancelled },
      },
    ],
  };
}

type Handler<K extends QuestionnaireAction["kind"]> = (
  state: QuestionnaireState,
  action: Extract<QuestionnaireAction, { kind: K }>,
  ctx: ApplyContext,
) => ApplyResult;

export function reduce(
  state: QuestionnaireState,
  action: QuestionnaireAction,
  ctx: ApplyContext,
): ApplyResult {
  return (
    (
      {
        nav: ((state, action, ctx) => {
          const item = (ctx.itemsByTab[state.currentTab] ?? [])[
            action.nextIndex
          ];
          const inputMode = item
            ? ROW_INTENT_META[item.kind].activatesInputMode
            : false;
          const next: QuestionnaireState = {
            ...state,
            optionIndex: action.nextIndex,
            inputMode,
          };
          if (!inputMode)
            return { state: next, effects: [{ kind: "clear_input_buffer" }] };
          const prior = state.answers.get(state.currentTab);
          const priorText =
            prior?.kind === "custom"
              ? prior.answer
              : prior?.kind === "multi"
                ? prior.custom
                : undefined;
          if (typeof priorText === "string") {
            return {
              state: next,
              effects: [{ kind: "set_input_buffer", value: priorText }],
            };
          }
          return { state: next, effects: [] };
        }) satisfies Handler<"nav">,
        tab_switch: ((state, action, ctx) =>
          switchTabResult(
            state,
            action.nextTab,
            ctx,
          )) satisfies Handler<"tab_switch">,
        confirm: ((state, action, ctx) => {
          const answer = action.answer;
          const answers = new Map(state.answers);
          answers.set(answer.questionIndex, answer);
          const next: QuestionnaireState = { ...state, answers };
          if (action.autoAdvanceTab !== undefined)
            return switchTabResult(next, action.autoAdvanceTab, ctx);
          return doneFor(next, ctx, false);
        }) satisfies Handler<"confirm">,
        toggle: ((state, action, ctx) => {
          const checked = new Set(state.multiSelectChecked);
          if (checked.has(action.index)) checked.delete(action.index);
          else checked.add(action.index);
          const intermediate: QuestionnaireState = {
            ...state,
            multiSelectChecked: checked,
          };
          return {
            state: {
              ...intermediate,
              answers: persistMultiSelectAnswer(
                intermediate,
                ctx,
                state.answers.get(state.currentTab)?.custom,
              ),
            },
            effects: [],
          };
        }) satisfies Handler<"toggle">,
        multi_confirm: ((state, action, ctx) => {
          const q = ctx.questions[state.currentTab];
          if (!q) return { state, effects: [] };
          const answers = new Map(state.answers);
          answers.set(
            state.currentTab,
            buildMultiSelectAnswer(
              state,
              q,
              state.answers.get(state.currentTab)?.custom,
            ),
          );
          const next: QuestionnaireState = { ...state, answers };
          if (action.autoAdvanceTab !== undefined)
            return switchTabResult(next, action.autoAdvanceTab, ctx);
          return doneFor(next, ctx, false);
        }) satisfies Handler<"multi_confirm">,
        custom_text: ((state, action, ctx) => ({
          state: {
            ...state,
            answers: persistMultiSelectAnswer(state, ctx, action.text),
          },
          effects: [],
        })) satisfies Handler<"custom_text">,
        cancel: (s, _a, c) => doneFor(s, c, true),
        submit: (s, _a, c) => doneFor(s, c, false),
        submit_nav: (s, a) => ({
          state: { ...s, submitChoiceIndex: a.nextIndex },
          effects: [],
        }),
        toggle_collapsed: (s) => ({
          state: { ...s, collapsed: !s.collapsed },
          effects: [],
        }),
        ignore: (s) => ({ state: s, effects: [] }),
      } satisfies { [K in QuestionnaireAction["kind"]]: Handler<K> }
    )[action.kind] as Handler<typeof action.kind>
  )(state, action as never, ctx);
}

interface QuestionnaireSessionConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  params: QuestionParams;
  itemsByTab: WrappingSelectItem[][];
  done: (result: QuestionnaireResult) => void;
}

interface QuestionnaireSessionComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    answers: new Map(),
    multiSelectChecked: new Set(),
    submitChoiceIndex: 0,
    collapsed: false,
  };
}

export class QuestionnaireSession {
  private state: QuestionnaireState = initialState();

  private readonly questions: readonly QuestionData[];
  private readonly isMulti: boolean;
  private readonly itemsByTab: WrappingSelectItem[][];

  private readonly inlineInput: Input;
  private readonly viewAdapter: QuestionnairePropsAdapter;

  private readonly tui: QuestionnaireSessionConfig["tui"];
  private readonly done: QuestionnaireSessionConfig["done"];

  readonly component: QuestionnaireSessionComponent;

  constructor(config: QuestionnaireSessionConfig) {
    this.tui = config.tui;
    this.done = config.done;
    this.questions = config.params.questions;
    this.isMulti = this.questions.length > 1;
    this.itemsByTab = config.itemsByTab;

    const built = buildQuestionnaire({
      tui: this.tui,
      theme: config.theme,
      questions: this.questions,
      itemsByTab: this.itemsByTab,
      isMulti: this.isMulti,
      initialState: this.state,
      getCurrentTab: () => this.state.currentTab,
    });

    this.inlineInput = built.inlineInput;
    this.viewAdapter = built.adapter;
    const collapsedRender = (_width: number): string[] => [
      config.theme.fg("dim", ` ${COLLAPSED_HINT} `),
    ];

    this.component = {
      render: (width) =>
        this.state.collapsed ? collapsedRender(width) : built.render(width),
      invalidate: built.invalidate,
      handleInput: (data) => this.dispatch(data),
    };

    this.viewAdapter.apply(this.state);
  }

  private dispatch(data: string): void {
    const action = routeKey(data, this.state, this.runtime());
    if (action.kind === "ignore") {
      this.handleIgnoreInline(data);
      return;
    }
    this.commit(action);
  }

  private commit(action: QuestionnaireAction): void {
    const result = reduce(this.state, action, this.applyContext());
    this.state = result.state;
    for (const effect of result.effects) this.runEffect(effect);
    this.viewAdapter.apply(this.state);
  }

  private runEffect(effect: Effect): void {
    switch (effect.kind) {
      case "set_input_buffer":
        this.inlineInput.setValue("");
        this.inlineInput.handleInput(`\x1b[200~${effect.value}\x1b[201~`);
        return;
      case "clear_input_buffer":
        this.inlineInput.setValue("");
        return;
      case "done":
        this.done(effect.result);
        return;
    }
  }

  private handleIgnoreInline(data: string): void {
    if (!this.state.inputMode) return;
    this.inlineInput.handleInput(data);
    if (this.questions[this.state.currentTab]?.multiSelect) {
      this.commit({ kind: "custom_text", text: this.inlineInput.getValue() });
      return;
    }
    this.viewAdapter.apply(this.state);
  }

  private runtime(): QuestionnaireRuntime {
    return {
      keybindings: getKeybindings(),
      inputBuffer: this.inlineInput.getValue(),
      questions: this.questions,
      isMulti: this.isMulti,
      currentItem: this.currentItem(),
      items: this.itemsByTab[this.state.currentTab] ?? [],
    };
  }

  private applyContext(): ApplyContext {
    return { questions: this.questions, itemsByTab: this.itemsByTab };
  }

  private currentItem(): WrappingSelectItem | undefined {
    return this.itemsByTab[this.state.currentTab]?.[this.state.optionIndex];
  }
}
