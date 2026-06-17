// /resend — re-run the agent loop on the existing transcript.
//
// Use after you abort a prompt mid-stream (or it stalls and auto-retry gives
// up). The transcript still ends at your message A; this re-runs inference on
// it as-is — no duplicate A appended, unlike sending a fresh message.
//
// pi exposes no public "continue" primitive (every public path appends a
// message), so we reach the live AgentSession and call its internal
// agent.continue() — the same call auto-retry uses. Before continuing we drop
// any trailing aborted/error assistant so the transcript ends at a user /
// tool-result message, which continue() requires.
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
  // Reach the internal Agent and its mutable transcript.
  const agent = (session as unknown as { agent: AgentContinuable }).agent;
  const msgs = agent.state.messages;
  // Trim trailing assistant messages (e.g. an aborted/error turn) so the
  // transcript ends at the user/tool-result message continue() needs.
  //
  // Deliberately only trim assistant turns, NOT trailing tool-results: if you
  // abort mid-tool, an aborted tool-result is left in context and continue()
  // resumes from it rather than re-running the original prompt. Keeping it for
  // now to see whether that surfaces any issue in practice; revisit (trim back
  // to the last user message) if a clean prompt re-run turns out to be wanted.
  let end = msgs.length;
  while (end > 0 && msgs[end - 1].role === "assistant") end--;
  if (end === 0) {
    ctx.ui.notify("Nothing to retrigger", "warning");
    return;
  }
  if (end !== msgs.length) agent.state.messages = msgs.slice(0, end);
  try {
    await agent.continue();
  } catch (e) {
    ctx.ui.notify(`Retrigger failed: ${(e as Error).message}`, "error");
  }
}

interface AgentContinuable {
  state: { messages: { role: string }[] };
  continue(): Promise<void>;
}

export default function resendExtension(pi: ExtensionAPI): void {
  pi.registerCommand("resend", {
    description:
      "Resend: re-run the agent on the current transcript (no message appended)",
    handler: async (_args, ctx) => resend(ctx),
  });
}
