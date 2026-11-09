import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { customEntries } from "../shared/session.ts";
import { Helium, resolveProfile } from "./helium.ts";
import type { DevtoolsReport } from "./devtools.ts";
import { runGoal, type Models, type Outcome, type Step } from "./jev.ts";

const TOOL_NAME = "browser";
const TOGGLE_ENTRY = "browser-toggle";

const describe = (step: Step) =>
  `${step.operation} ${step.action}${step.text === undefined ? "" : ` ← ${JSON.stringify(step.text)}`}`;

async function resolveModels(ctx: ExtensionContext): Promise<Models> {
  const jev = (
    await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe")
  ).find((model) => model.id === "jev-latest");
  if (!jev)
    throw new Error(
      "Jev is unavailable. Set TYPESAFE_API_KEY to a TypeSafe key and restart pi.",
    );
  const writer = ctx.modelRegistry.find("anthropic", "claude-haiku-5-5");
  if (!writer || !ctx.modelRegistry.hasConfiguredAuth(writer))
    throw new Error(
      "anthropic/claude-haiku-5-5 is unavailable. Log in to Anthropic with /login.",
    );
  return { registry: ctx.modelRegistry, jev, writer };
}

const params = Type.Object({
  goal: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "One natural-language goal with every value it needs, e.g. 'Search one-way flights from Zurich to London on 2026-12-20 for one adult'. Omit it to only open `url` with `devtools`.",
    }),
  ),
  url: Type.Optional(
    Type.String({ description: "Page to open before the task starts." }),
  ),
  profile: Type.Optional(
    Type.String({
      description:
        "Helium profile name, only when the user names one. Default: the profile Helium used last.",
    }),
  ),
  devtools: Type.Optional(
    Type.Boolean({
      description:
        "Also report the console messages and network requests of this call, as the developer tools show them.",
    }),
  ),
});

const formatDevtools = (report: DevtoolsReport) => {
  const counts = (record: Record<string, number>) =>
    Object.entries(record)
      .sort(([, a], [, b]) => b - a)
      .map(([key, n]) => `${key} ${n}`)
      .join(", ");
  return [
    `Console: ${counts(report.console_by_level) || "no messages"}`,
    ...report.console.map(
      (entry) =>
        `  [${entry.level}] ${entry.text}${entry.location ? ` (${entry.location})` : ""}`,
    ),
    `Network: ${report.requests} requests${report.requests ? ` (${counts(report.requests_by_type)})` : ""}, ${report.problem_requests.length} failed or 4xx/5xx`,
    ...report.problem_requests.map(
      (request) =>
        `  ${request.method} ${request.failure ?? request.status} ${request.url}`,
    ),
    `Full log: ${report.log_path}`,
  ];
};

export default function (pi: ExtensionAPI) {
  let helium: Helium | undefined;
  let heliumProfile: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const showStatus = (ctx: ExtensionContext) => {
    if (!pi.getActiveTools().includes(TOOL_NAME))
      ctx.ui.setStatus(TOOL_NAME, undefined);
    else ctx.ui.setStatus(TOOL_NAME, `browser:${helium?.label ?? "on"}`);
  };

  const closeHelium = async () => {
    const running = helium;
    helium = undefined;
    heliumProfile = undefined;
    await running?.close();
  };

  const offerTool = (offered: boolean) => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME) === offered) return;
    pi.setActiveTools(
      offered
        ? [...active, TOOL_NAME]
        : active.filter((name) => name !== TOOL_NAME),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    const last = customEntries<{ enabled: boolean }>(
      ctx.sessionManager.getBranch(),
      TOGGLE_ENTRY,
    ).at(-1);
    offerTool(last?.data?.enabled ?? false);
    showStatus(ctx);
  });

  pi.on("session_shutdown", closeHelium);

  pi.on("agent_settled", async (_event, ctx) => {
    await queue;
    await closeHelium();
    showStatus(ctx);
  });

  pi.registerCommand("browser", {
    description:
      "Turn the background Helium browser tool on or off for this session",
    handler: async (_args, ctx) => {
      const enabled = !pi.getActiveTools().includes(TOOL_NAME);
      offerTool(enabled);
      pi.appendEntry(TOGGLE_ENTRY, { enabled });
      if (!enabled) await closeHelium();
      showStatus(ctx);
    },
  });

  pi.registerTool<typeof params, { summary: string }>({
    name: TOOL_NAME,
    label: "Browser",
    defaultActive: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Finish one concrete web task in the background in the user's Helium browser, signed in as the user: search, fill and submit forms, pick options, open results. " +
      "Pass `url` to start there. Without `url`, it continues on the page of the previous browser call in the same turn. " +
      "Returns the status, the steps taken, and the visible page text. A `done` status is the browser's own claim, so make sure that the page text shows the result before you rely on it. " +
      "Set `devtools` to also get the console errors and warnings and the failed network requests, like the browser's developer tools. With `devtools` and `url` but no `goal`, it only opens the page and reports them. " +
      "It cannot use frames, shadow DOM, file uploads, or popup windows.",
    parameters: params,
    outputSchema: Type.Object({
      status: Type.Union([
        Type.Literal("done"),
        Type.Literal("blocked"),
        Type.Literal("error"),
      ]),
      reason: Type.Optional(Type.String()),
      url: Type.String(),
      title: Type.String(),
      steps: Type.Array(Type.String()),
      page_text: Type.Optional(
        Type.String({ description: "Visible text of the final page" }),
      ),
      devtools: Type.Optional(
        Type.Object({
          console: Type.Array(
            Type.Object({
              level: Type.String(),
              source: Type.String(),
              text: Type.String(),
              location: Type.Optional(Type.String()),
            }),
            { description: "Errors and warnings, at most 30" },
          ),
          console_by_level: Type.Record(Type.String(), Type.Number()),
          problem_requests: Type.Array(
            Type.Object({
              method: Type.String(),
              url: Type.String(),
              type: Type.Optional(Type.String()),
              status: Type.Optional(Type.Number()),
              failure: Type.Optional(Type.String()),
              bytes: Type.Optional(Type.Number()),
              ms: Type.Optional(Type.Number()),
            }),
            { description: "Failed or 4xx/5xx requests, at most 30" },
          ),
          requests: Type.Number(),
          requests_by_type: Type.Record(Type.String(), Type.Number()),
          log_path: Type.String({
            description: "Every console message and request as JSON",
          }),
        }),
      ),
      elapsed_ms: Type.Number(),
    }),
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("browser"))} ${theme.fg("accent", args.goal ?? "")}` +
          theme.fg(
            "dim",
            [args.url, args.profile && `profile ${args.profile}`]
              .filter(Boolean)
              .map((part) => ` (${part})`)
              .join(""),
          ),
      );
      return text;
    },
    renderResult(result, _options, theme) {
      return new Text(
        theme.fg("dim", `  ${result.details?.summary ?? "browser"}`),
        0,
        0,
      );
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const goal = params.goal;
      if (!goal && !(params.devtools && params.url))
        throw new Error("Pass a goal, or devtools: true with a url.");
      const run = async () => {
        const models = goal ? await resolveModels(ctx) : undefined;
        const profile = await resolveProfile(params.profile);
        if (!helium || (params.profile && heliumProfile !== profile.dir)) {
          await closeHelium();
          helium = await Helium.open(profile, params.profile !== undefined);
          heliumProfile = profile.dir;
          showStatus(ctx);
        }
        const browser = helium;
        const started = Date.now();
        const recorder = params.devtools
          ? await browser.recordDevtools()
          : undefined;
        try {
          if (params.url) await browser.navigate(params.url);
          const lines: string[] = [];
          const outcome: Outcome =
            goal && models
              ? await runGoal(
                  browser,
                  models,
                  goal,
                  (step) => {
                    lines.push(describe(step));
                    onUpdate?.({
                      content: [{ type: "text", text: lines.join("\n") }],
                      details: { summary: `${lines.length} steps` },
                    });
                  },
                  signal,
                )
              : { status: "done", page: await browser.observe(), steps: [] };
          await recorder?.quiet();
          const devtools = await recorder?.report();
          return { outcome, devtools, elapsed: Date.now() - started };
        } finally {
          if (recorder) await browser.stopDevtools();
        }
      };
      const pending = queue.then(run);
      queue = pending.catch(() => undefined);
      const { outcome, devtools, elapsed } = await pending;

      const steps = outcome.steps.map(describe);
      const summary = `${outcome.status} · ${steps.length} steps · ${(elapsed / 1000).toFixed(1)} s · ${outcome.page.url}`;
      return {
        content: [
          {
            type: "text",
            text: [
              summary,
              ...(outcome.reason ? [outcome.reason] : []),
              `Title: ${outcome.page.title}`,
              ...steps.map((line, i) => `${i + 1}. ${line}`),
              ...(devtools ? formatDevtools(devtools) : []),
              ...(goal ? ["Page text:", outcome.page.text] : []),
            ].join("\n"),
          },
        ],
        details: { summary },
        structuredContent: {
          status: outcome.status,
          ...(outcome.reason && { reason: outcome.reason }),
          url: outcome.page.url,
          title: outcome.page.title,
          steps,
          ...(goal && { page_text: outcome.page.text }),
          ...(devtools && { devtools }),
          elapsed_ms: elapsed,
        },
        ...(outcome.status === "error" && { isError: true }),
      };
    },
  });
}
