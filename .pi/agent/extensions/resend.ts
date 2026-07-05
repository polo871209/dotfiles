// /resend — re-run the agent loop on the existing transcript, and (if RULES
// below is non-empty) an automatic mid-stream watchdog that does the same
// resume for you.
//
// Manual case: use after you abort a prompt mid-stream (or it stalls and
// auto-retry gives up). The transcript still ends at your message A; this
// re-runs inference on it as-is — no duplicate A appended, unlike sending a
// fresh message.
//
// Automatic case ("stream rules", ported from oh-my-pi's TTSR): a regex hits
// the model's streaming text/thinking output, the turn aborts immediately,
// and a hidden reminder gets appended and inference resumes — course-
// correction without spending a review pass every turn. Both cases share the
// same primitive: trim the trailing assistant turn so the transcript ends at
// a user/tool-result message, then resume generation from there.
//
// pi exposes no public "continue" primitive (every public path appends a
// message), so we reach the live AgentSession and call its internal
// agent.continue() — the same call auto-retry uses.
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extractText } from "./shared/message";

interface Captured {
  active: AgentSession | undefined;
}

// Capture the live AgentSession by wrapping a few instance methods on the
// prototype. Stored on globalThis (not module scope) so it survives extension
// reloads — the wrapper installed on first load keeps writing to the same slot,
// and re-running this factory finds the guard already set and skips re-patching.
function captureSlot(): Captured {
  const g = globalThis as unknown as { __piRetrigger?: Captured };
  if (g.__piRetrigger) return g.__piRetrigger;
  const slot: Captured = { active: undefined };
  g.__piRetrigger = slot;
  const proto = AgentSession.prototype as unknown as Record<string, unknown>;
  for (const name of ["subscribe", "prompt", "sendCustomMessage"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    proto[name] = function (this: AgentSession, ...args: unknown[]) {
      slot.active = this;
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  return slot;
}

const slot = captureSlot();

interface AgentContinuable {
  state: { messages: AgentTranscriptMessage[] };
  continue(): Promise<void>;
}

interface AgentTranscriptMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
}

// Trim trailing assistant messages (e.g. an aborted/error turn) so the
// transcript ends at the user/tool-result message continue() needs. Returns
// the trimmed array unchanged (by reference) when there's nothing to trim.
//
// Deliberately only trims assistant turns, NOT trailing tool-results: if you
// abort mid-tool, an aborted tool-result is left in context and continue()
// resumes from it rather than re-running the original prompt. Keeping it for
// now to see whether that surfaces any issue in practice; revisit (trim back
// to the last user message) if a clean prompt re-run turns out to be wanted.
function trimTrailingAssistant(
  msgs: AgentTranscriptMessage[],
): AgentTranscriptMessage[] {
  let end = msgs.length;
  while (end > 0 && msgs[end - 1]!.role === "assistant") end--;
  return end === msgs.length ? msgs : msgs.slice(0, end);
}

async function resend(ctx: ExtensionContext): Promise<void> {
  const session = slot.active;
  if (!session) {
    ctx.ui.notify("No active session to retrigger", "warning");
    return;
  }
  if (session.isStreaming) {
    ctx.ui.notify("Agent busy — nothing to retrigger", "warning");
    return;
  }
  const agent = (session as unknown as { agent: AgentContinuable }).agent;
  const msgs = agent.state.messages;
  const trimmed = trimTrailingAssistant(msgs);
  if (trimmed.length === 0) {
    ctx.ui.notify("Nothing to retrigger", "warning");
    return;
  }
  if (trimmed !== msgs) agent.state.messages = trimmed;
  try {
    await agent.continue();
  } catch (e) {
    ctx.ui.notify(`Retrigger failed: ${(e as Error).message}`, "error");
  }
}

// --- Stream rules (TTSR-lite) -----------------------------------------
//
// A regex hits the model's streaming text/thinking output → the turn aborts
// → a hidden reminder is appended as a user turn → generation resumes via
// the same trim+continue() primitive `resend` uses. Empty by default: zero
// cost (no message_update listener even registered) until you add a rule.
//
// Add project- or habit-specific corrections here, e.g.:
//   { name: "no-box-leak", pattern: /Box::leak/, message: "Don't reach for Box::leak in production code paths. Use Arc<str> or similar." }
interface StreamRule {
  name: string;
  pattern: RegExp;
  /** Which streamed content to test against. Default "any" (text + thinking). */
  scope?: "text" | "thinking" | "any";
  /** Reminder text injected as a hidden user turn on match. */
  message: string;
  /** "once" (default): fires once per session per rule. "always": every match. */
  repeat?: "once" | "always";
}

const RULES: StreamRule[] = [];

const triggeredBySession = new WeakMap<AgentSession, Set<string>>();

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: "thinking"; thinking: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "thinking" &&
        typeof (c as { thinking?: unknown }).thinking === "string",
    )
    .map((c) => c.thinking)
    .join("\n");
}

function matchRule(
  session: AgentSession,
  content: unknown,
): StreamRule | undefined {
  let triggered = triggeredBySession.get(session);
  if (!triggered) {
    triggered = new Set();
    triggeredBySession.set(session, triggered);
  }
  const text = extractText(content);
  const thinking = extractThinking(content);
  for (const rule of RULES) {
    if (rule.repeat !== "always" && triggered.has(rule.name)) continue;
    const haystack =
      rule.scope === "text"
        ? text
        : rule.scope === "thinking"
          ? thinking
          : `${text}\n${thinking}`;
    if (rule.pattern.test(haystack)) {
      triggered.add(rule.name);
      return rule;
    }
  }
  return undefined;
}

// Abort already fired (synchronously, from the message_update handler); this
// runs after a short delay so the abort settles before we touch the
// transcript — mirrors TTSR's own 50ms retry-scheduling gap.
async function injectAndContinue(
  session: AgentSession,
  rule: StreamRule,
): Promise<void> {
  const agent = (session as unknown as { agent: AgentContinuable }).agent;
  const kept = trimTrailingAssistant(agent.state.messages);
  const reminder: AgentTranscriptMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-reminder rule="${rule.name}">\n${rule.message}\n</system-reminder>`,
      },
    ],
    timestamp: Date.now(),
  };
  agent.state.messages = [...kept, reminder];
  try {
    await agent.continue();
  } catch {
    // Best effort — matches resend()'s own swallow-on-failure for this path;
    // the manual /resend command still surfaces failures via ctx.ui.notify.
  }
}

export default function resendExtension(pi: ExtensionAPI): void {
  pi.registerCommand("resend", {
    description:
      "Re-run the agent on the current transcript (no message appended)",
    handler: async (_args, ctx) => resend(ctx),
  });

  if (RULES.length === 0) return;

  pi.on("message_update", async (event) => {
    const ev = event.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta") return;
    const session = slot.active;
    if (!session) return;
    const rule = matchRule(
      session,
      (event.message as { content?: unknown }).content,
    );
    if (!rule) return;
    void session.abort();
    setTimeout(() => void injectAndContinue(session, rule), 50);
  });
}
