// The questionnaire state machine and its runtime host.
//
//   routeKey  : (key, state, runtime) → action   — pure key dispatch
//   reduce    : (state, action, ctx) → (state, effects[]) — pure transition
//   QuestionnaireSession : owns the canonical state cell + the inline Input,
//                          runs effects, and fans state out to the view.

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

// State

export interface QuestionnaireState {
  currentTab: number;
  optionIndex: number;
  inputMode: boolean;
  chatFocused: boolean;
  answers: ReadonlyMap<number, QuestionAnswer>;
  multiSelectChecked: ReadonlySet<number>;
  submitChoiceIndex: number;
  collapsed: boolean;
}

export interface QuestionnaireRuntime {
  keybindings: { matches(data: string, name: string): boolean };
  inputBuffer: string;
  questions: readonly QuestionData[];
  isMulti: boolean;
  currentItem: WrappingSelectItem | undefined;
  items: readonly WrappingSelectItem[];
}

export type ActiveView = "chat" | "options" | "submit";

/** Priority: submit > chat > options. Mirrors the routeKey cascade. */
export function selectActiveView(
  state: { chatFocused: boolean; currentTab: number },
  totalQuestions: number,
): ActiveView {
  if (state.currentTab === totalQuestions) return "submit";
  if (state.chatFocused) return "chat";
  return "options";
}

/** Build the option rows (author options + appended sentinels) for one question. */
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

// Actions (key-router output)

export type QuestionnaireAction =
  | { kind: "nav"; nextIndex: number }
  | { kind: "tab_switch"; nextTab: number }
  | { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
  | { kind: "toggle"; index: number }
  | { kind: "multi_confirm"; selected: string[]; autoAdvanceTab?: number }
  | { kind: "cancel" }
  | { kind: "submit" }
  | { kind: "submit_nav"; nextIndex: 0 | 1 }
  | { kind: "focus_chat" }
  | { kind: "focus_options"; optionIndex: number }
  | { kind: "toggle_collapsed" }
  | { kind: "ignore" };

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";
const SPACE_KEY = " ";

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
  if (item?.kind === "chat") {
    return {
      questionIndex: state.currentTab,
      question: q.question,
      kind: "chat",
      answer: item.label,
    };
  }
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

function buildMultiSelected(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): string[] {
  const q = runtime.questions[state.currentTab];
  if (!q) return [];
  const out: string[] = [];
  for (let i = 0; i < q.options.length; i++) {
    if (state.multiSelectChecked.has(i)) {
      const label = q.options[i]?.label;
      if (typeof label === "string") out.push(label);
    }
  }
  return out;
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

function nextNavOnDown(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  if (
    runtime.items.length > 0 &&
    state.optionIndex === runtime.items.length - 1
  )
    return { kind: "focus_chat" };
  return {
    kind: "nav",
    nextIndex: wrapTab(
      state.optionIndex + 1,
      Math.max(1, runtime.items.length),
    ),
  };
}

function prevNavOnUp(
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  if (runtime.items.length > 0 && state.optionIndex === 0)
    return { kind: "focus_chat" };
  return {
    kind: "nav",
    nextIndex: wrapTab(
      state.optionIndex - 1,
      Math.max(1, runtime.items.length),
    ),
  };
}

export function routeKey(
  data: string,
  state: QuestionnaireState,
  runtime: QuestionnaireRuntime,
): QuestionnaireAction {
  const kb = runtime.keybindings;

  // Collapse/expand: intercepted from every inner mode. Ctrl+] is free in every
  // mainstream terminal + multiplexer.
  if (matchesKey(data, Key.ctrl("]"))) return { kind: "toggle_collapsed" };

  if (state.collapsed) {
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    return { kind: "ignore" };
  }

  if (state.chatFocused) {
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    if (kb.matches(data, KEYBIND_CONFIRM)) {
      const answer = buildSingleSelectAnswer(state, runtime);
      if (!answer) return { kind: "ignore" };
      return {
        kind: "confirm",
        answer,
        autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
      };
    }
    if (kb.matches(data, KEYBIND_UP)) {
      return {
        kind: "focus_options",
        optionIndex: Math.max(0, runtime.items.length - 1),
      };
    }
    if (kb.matches(data, KEYBIND_DOWN))
      return { kind: "focus_options", optionIndex: 0 };
    const tab = tabSwitchAction(data, state, runtime);
    if (tab) return tab;
    return { kind: "ignore" };
  }

  if (state.inputMode) {
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
    if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
    if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);
    return { kind: "ignore" };
  }

  if (runtime.isMulti && state.currentTab === runtime.questions.length) {
    if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
    const tab = tabSwitchAction(data, state, runtime);
    if (tab) return tab;
    if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
      const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
      const next = wrapTab(state.submitChoiceIndex + delta, 2);
      return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
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

  if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
  if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);

  if (q.multiSelect) {
    const focusedKind = runtime.currentItem?.kind;
    const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
    if (data === SPACE_KEY) {
      if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
      return { kind: "toggle", index: state.optionIndex };
    }
    if (kb.matches(data, KEYBIND_CONFIRM)) {
      if (!focusedMeta?.autoSubmitsInMulti)
        return { kind: "toggle", index: state.optionIndex };
      return {
        kind: "multi_confirm",
        selected: buildMultiSelected(state, runtime),
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

// Reducer

export type Effect =
  | { kind: "set_input_buffer"; value: string }
  | { kind: "clear_input_buffer" }
  | { kind: "done"; result: QuestionnaireResult };

export interface ApplyContext {
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
  const labels = answers.get(tab)?.selected ?? [];
  const indices = new Set<number>();
  for (let i = 0; i < q.options.length; i++) {
    if (labels.includes(q.options[i]!.label)) indices.add(i);
  }
  return indices;
}

function persistMultiSelectAnswer(
  state: QuestionnaireState,
  ctx: ApplyContext,
): ReadonlyMap<number, QuestionAnswer> {
  const q = ctx.questions[state.currentTab];
  if (!q?.multiSelect) return state.answers;
  const selected: string[] = [];
  for (let i = 0; i < q.options.length; i++) {
    if (state.multiSelectChecked.has(i)) selected.push(q.options[i]!.label);
  }
  const out = new Map(state.answers);
  if (selected.length === 0) {
    out.delete(state.currentTab);
    return out;
  }
  out.set(state.currentTab, {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "multi",
    answer: null,
    selected,
  });
  return out;
}

function switchTabResult(
  state: QuestionnaireState,
  nextTab: number,
  ctx: ApplyContext,
): ApplyResult {
  const transitioned: QuestionnaireState = {
    ...state,
    currentTab: nextTab,
    optionIndex: 0,
    inputMode: false,
    chatFocused: false,
    submitChoiceIndex: 0,
    multiSelectChecked: syncMultiSelectFromAnswers(
      state.answers,
      ctx.questions,
      nextTab,
    ),
  };
  return { state: transitioned, effects: [] };
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

const navHandler: Handler<"nav"> = (state, action, ctx) => {
  const items = ctx.itemsByTab[state.currentTab] ?? [];
  const item = items[action.nextIndex];
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
  if (prior?.kind === "custom" && typeof prior.answer === "string") {
    return {
      state: next,
      effects: [{ kind: "set_input_buffer", value: prior.answer }],
    };
  }
  return { state: next, effects: [] };
};

const tabSwitchHandler: Handler<"tab_switch"> = (state, action, ctx) =>
  switchTabResult(state, action.nextTab, ctx);

const confirmHandler: Handler<"confirm"> = (state, action, ctx) => {
  const answer = action.answer;
  const answers = new Map(state.answers);
  answers.set(answer.questionIndex, answer);
  const next: QuestionnaireState = { ...state, answers };
  if (answer.kind === "chat") return doneFor(next, ctx, false);
  if (action.autoAdvanceTab !== undefined)
    return switchTabResult(next, action.autoAdvanceTab, ctx);
  return doneFor(next, ctx, false);
};

const toggleHandler: Handler<"toggle"> = (state, action, ctx) => {
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
      answers: persistMultiSelectAnswer(intermediate, ctx),
    },
    effects: [],
  };
};

const multiConfirmHandler: Handler<"multi_confirm"> = (state, action, ctx) => {
  const q = ctx.questions[state.currentTab];
  if (!q) return { state, effects: [] };
  const answers = new Map(state.answers);
  answers.set(state.currentTab, {
    questionIndex: state.currentTab,
    question: q.question,
    kind: "multi",
    answer: null,
    selected: action.selected,
  });
  const synced: QuestionnaireState = {
    ...state,
    answers,
    multiSelectChecked: syncMultiSelectFromAnswers(
      answers,
      ctx.questions,
      state.currentTab,
    ),
  };
  if (action.autoAdvanceTab !== undefined)
    return switchTabResult(synced, action.autoAdvanceTab, ctx);
  return doneFor(synced, ctx, false);
};

const focusOptionsHandler: Handler<"focus_options"> = (state, action, ctx) => {
  const items = ctx.itemsByTab[state.currentTab] ?? [];
  const focused = items[action.optionIndex];
  const inputMode = focused
    ? ROW_INTENT_META[focused.kind].activatesInputMode
    : false;
  const next: QuestionnaireState = {
    ...state,
    chatFocused: false,
    optionIndex: action.optionIndex,
    inputMode,
  };
  return {
    state: next,
    effects: inputMode ? [] : [{ kind: "clear_input_buffer" }],
  };
};

const HANDLERS: { [K in QuestionnaireAction["kind"]]: Handler<K> } = {
  nav: navHandler,
  tab_switch: tabSwitchHandler,
  confirm: confirmHandler,
  toggle: toggleHandler,
  multi_confirm: multiConfirmHandler,
  cancel: (s, _a, c) => doneFor(s, c, true),
  submit: (s, _a, c) => doneFor(s, c, false),
  submit_nav: (s, a) => ({
    state: { ...s, submitChoiceIndex: a.nextIndex },
    effects: [],
  }),
  focus_chat: (s) => ({ state: { ...s, chatFocused: true }, effects: [] }),
  focus_options: focusOptionsHandler,
  toggle_collapsed: (s) => ({
    state: { ...s, collapsed: !s.collapsed },
    effects: [],
  }),
  ignore: (s) => ({ state: s, effects: [] }),
};

export function reduce(
  state: QuestionnaireState,
  action: QuestionnaireAction,
  ctx: ApplyContext,
): ApplyResult {
  const handler = HANDLERS[action.kind] as Handler<typeof action.kind>;
  return handler(state, action as never, ctx);
}

// Runtime host

// Ctrl-E → cursor-line-end (pi-tui keybinding); used to park the inline cursor
// at end after setValue rehydration.
const CURSOR_END = "\x05";

export interface QuestionnaireSessionConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  params: QuestionParams;
  itemsByTab: WrappingSelectItem[][];
  done: (result: QuestionnaireResult) => void;
}

export interface QuestionnaireSessionComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    chatFocused: false,
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

    const theme = config.theme;
    const collapsedRender = (_width: number): string[] => [
      theme.fg("dim", ` ${COLLAPSED_HINT} `),
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
        this.inlineInput.setValue(effect.value);
        this.inlineInput.handleInput(CURSOR_END);
        return;
      case "clear_input_buffer":
        this.inlineInput.setValue("");
        return;
      case "done":
        this.done(effect.result);
        return;
    }
  }

  // Fast path for per-keystroke typing in the inline free-text row: route to
  // the headless Input so paste/CSI-u decode work, then re-project without a
  // reducer round-trip.
  private handleIgnoreInline(data: string): void {
    if (!this.state.inputMode) return;
    this.inlineInput.handleInput(data);
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
    if (this.state.chatFocused)
      return { kind: "chat", label: sentinelLabel("chat") };
    const arr = this.itemsByTab[this.state.currentTab] ?? [];
    if (this.state.optionIndex < arr.length) return arr[this.state.optionIndex];
    return { kind: "chat", label: sentinelLabel("chat") };
  }
}
