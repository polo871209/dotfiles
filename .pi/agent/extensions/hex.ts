import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./shared/error";
import { sideChannelComplete } from "./shared/llm";
import { resultCard, stepsWidget } from "./shared/progress";
import { extractText } from "./shared/message";

const HEX = "/Applications/Hex.app/Contents/MacOS/hex";

type Dictation = { final_text: string; raw_text: string | null };
type Fix = { term: string; misheard: string[] };

const SYSTEM_PROMPT = `
The user dictates with Hex, a speech-to-text app, and Hex misheard one or more names. Find them so Hex can learn them.

Input: the user's hint (may be empty or loose, such as "cloud tasks" or "jeff is Jev"), the latest conversation turns, and the newest Hex dictations, each with its raw transcript and its final pasted text.

Find the words the speaker clearly meant as a name or term (product, tool, project, file, or person) but Hex wrote as other words or a wrong spelling. Use the hint first, then the conversation, then each dictation's own context.

Hex replaces a learned misheard spelling every time it hears it. Return only fixes whose misheard text is never meant literally, such as "cloud MD" for AGENTS.md. Skip an ordinary word or phrase the speaker can mean, such as "commons" for "comments", and skip grammar and style.

Reply with JSON only, no prose and no code fence:
{"fixes": [{"term": "<correct spelling>", "misheard": ["<exact text as it appears in a dictation>"]}]}

Each "misheard" string must appear verbatim in a dictation's raw or final text. If nothing qualifies, return {"fixes": []}.
`.trim();

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const phrasePattern = (phrase: string) =>
  new RegExp(`(?<!\\w)${escapeRegExp(phrase)}(?!\\w)`, "i");

const isHexCommand = (text: string) => /^\s*\/?hex\b/i.test(text);

const recentTurns = (ctx: ExtensionContext) =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) => {
      if (entry.type !== "message") return [];
      const { message } = entry;
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = extractText(message.content).trim();
      return text ? [`${message.role}: ${text.slice(0, 2000)}`] : [];
    })
    .slice(-4)
    .join("\n\n");

const parseFixes = (reply: string): Fix[] =>
  JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)).fixes;

type Result = { ok: boolean; text: string };

const MODEL_ID = "claude-sonnet-5-5";
const STEPS = [
  "read dictations",
  `find misheard names (${MODEL_ID})`,
  "teach Hex",
];

export default function (pi: ExtensionAPI) {
  let running: AbortController | undefined;

  pi.registerEntryRenderer<Result>(
    "hex",
    (entry, _options, theme) =>
      entry.data && resultCard("hex", entry.data.ok, entry.data.text, theme, 1),
  );

  pi.on("session_shutdown", () => {
    running?.abort();
    running = undefined;
  });

  const hex = async (signal: AbortSignal, ...args: string[]) => {
    const result = await pi.exec(HEX, args, { signal, timeout: 60_000 });
    if (result.code !== 0) {
      throw new Error(
        `hex ${args[0]}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result.stdout;
  };

  async function learn(
    hint: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
    step: (active: number) => void,
  ): Promise<Result | undefined> {
    const model = ctx.modelRegistry.find("anthropic", MODEL_ID);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      return { ok: false, text: `${MODEL_ID} is not configured` };
    }

    step(0);
    const { entries } = JSON.parse(
      await hex(signal, "history", "--raw", "--json", "--limit", "10"),
    ) as { entries: Dictation[] };
    const dictations = entries
      .filter((e) => !isHexCommand(e.final_text))
      .slice(0, 5);
    if (dictations.length === 0) {
      return { ok: false, text: "no recent dictation" };
    }

    step(1);
    const reply = await sideChannelComplete(ctx, {
      model,
      signal,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            `Hint: ${hint || "(none)"}`,
            `Latest conversation turns:\n${recentTurns(ctx) || "(none)"}`,
            "Dictations, newest first:",
            ...dictations.map(
              (d) =>
                `raw: ${d.raw_text ?? d.final_text}\nfinal: ${d.final_text}`,
            ),
          ].join("\n\n"),
        },
      ],
    });
    if (!reply.ok) {
      if (reply.reason === "aborted") return undefined;
      return { ok: false, text: reply.error ?? reply.reason };
    }

    const heard = dictations
      .map((d) => `${d.raw_text ?? ""}\n${d.final_text}`)
      .join("\n");
    const fixes = parseFixes(reply.text)
      .map((f) => ({
        term: f.term.trim(),
        misheard: f.misheard.filter((m) => phrasePattern(m).test(heard)),
      }))
      .filter((f) => f.term && f.misheard.length > 0);
    if (fixes.length === 0) {
      return {
        ok: false,
        text: "nothing misheard found. Name the word: /hex <word>",
      };
    }

    step(2);
    await hex(signal, "start");
    for (const { term, misheard } of fixes) {
      await hex(
        signal,
        "vocabulary",
        "add",
        term,
        "--sounds-like",
        misheard.join(","),
      );
    }
    return {
      ok: true,
      text: fixes
        .map((f) => `${f.misheard.map((m) => `"${m}"`).join(", ")} → ${f.term}`)
        .join("; "),
    };
  }

  const run = async (hint: string, ctx: ExtensionContext) => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    const step = (active: number) =>
      ctx.ui.setWidget("hex", stepsWidget("hex", STEPS, active), {
        placement: "aboveEditor",
      });
    try {
      const result = await learn(hint, ctx, controller.signal, step);
      if (result && !controller.signal.aborted) {
        pi.appendEntry<Result>("hex", result);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        pi.appendEntry<Result>("hex", { ok: false, text: errorMessage(e) });
      }
    } finally {
      if (running === controller) {
        running = undefined;
        ctx.ui.setWidget("hex", undefined);
      }
    }
  };

  pi.registerCommand("hex", {
    description:
      "Teach Hex the words it misheard in recent dictations, in the background: /hex [hint]",
    handler: async (args, ctx) => {
      void run(args.trim(), ctx);
    },
  });
}
