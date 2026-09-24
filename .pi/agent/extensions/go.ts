// /go: re-run the agent loop on the existing transcript without appending a
// message. Use it after you abort a prompt mid-stream, or after it stalls and
// auto-retry gives up. The transcript still ends at your message A, and this
// re-runs inference on it as-is, with no duplicate A.
//
// pi exposes no public "continue" from idle (every public path appends a
// message), so this reaches the live AgentSession and calls its internal
// agent.continue(), the same call auto-retry uses.
//
// Since pi 0.87 every request is built from the session record, not from
// agent.state.messages. The trim below only satisfies continue()'s "last
// message must not be assistant" guard. The provider request is correct
// because pi-ai drops aborted and errored assistant messages on its own. A
// completed assistant reply would be sent as-is, so /go refuses that case.
//
// A bare agent.continue() skips the session's run loop, so retries,
// agent_before_settle (lsp feedback) and agent_settled (notifier, subagent
// result file) never fire. resume() runs the continue inside that loop.
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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
  prompt(...args: unknown[]): Promise<void>;
  continue(): Promise<void>;
}

interface SessionRunLoop {
  _runAgentPrompt?(messages: unknown[]): Promise<void>;
}

// _runAgentPrompt starts with one agent.prompt(messages) call, then owns the
// post-run loop. Swap that single call for continue(), then restore.
async function resume(
  session: AgentSession,
  agent: AgentContinuable,
): Promise<void> {
  const run = (session as unknown as SessionRunLoop)._runAgentPrompt;
  if (typeof run !== "function") return agent.continue();
  const shadowed = Object.prototype.hasOwnProperty.call(agent, "prompt");
  const original = agent.prompt;
  const restore = () => {
    if (shadowed) agent.prompt = original;
    else delete (agent as Partial<AgentContinuable>).prompt;
  };
  agent.prompt = () => {
    restore();
    return agent.continue();
  };
  try {
    await run.call(session, []);
  } finally {
    restore();
  }
}

interface AgentTranscriptMessage {
  role: string;
  stopReason?: string;
}

const isAbandoned = (m: AgentTranscriptMessage): boolean =>
  m.role === "assistant" &&
  (m.stopReason === "aborted" || m.stopReason === "error");

// Trailing tool results stay: after an abort mid-tool, continue() resumes from
// the aborted tool result instead of re-running the original prompt.
function trimAbandoned(
  msgs: AgentTranscriptMessage[],
): AgentTranscriptMessage[] {
  let end = msgs.length;
  while (end > 0 && isAbandoned(msgs[end - 1]!)) end--;
  return end === msgs.length ? msgs : msgs.slice(0, end);
}

async function go(ctx: ExtensionContext): Promise<void> {
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
  const trimmed = trimAbandoned(msgs);
  if (trimmed.length === 0) {
    ctx.ui.notify("Nothing to retrigger", "warning");
    return;
  }
  if (trimmed.at(-1)!.role === "assistant") {
    ctx.ui.notify("Last reply finished. Send a message instead.", "warning");
    return;
  }
  if (trimmed !== msgs) agent.state.messages = trimmed;
  try {
    await resume(session, agent);
  } catch (e) {
    ctx.ui.notify(`Retrigger failed: ${(e as Error).message}`, "error");
  }
}

export default function goExtension(pi: ExtensionAPI): void {
  pi.registerCommand("go", {
    description:
      "Re-run the agent on the current transcript (no message appended)",
    handler: async (_args, ctx) => go(ctx),
  });

  // ctrl+alt+* is the one namespace pi leaves almost empty (it binds only
  // ctrl+alt+]), so extension shortcuts land there and survive an upgrade.
  pi.registerShortcut("ctrl+alt+g", {
    description: "Re-run the agent on the current transcript",
    handler: (ctx) => go(ctx),
  });
}
