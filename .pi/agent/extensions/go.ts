// pi exposes no public "continue" from idle (every public path appends a
// message), so this reaches the live AgentSession. Two internals remain:
// the session lookup below and AgentSession._runAgentPrompt. Everything else
// uses public API and follows pi's own auto-retry. A trailing aborted or
// errored reply gets a context_edit omission, so it stays in raw history but
// leaves model context for good, including after a resume.
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = AgentSession["agent"]["state"]["messages"][number];

// ExtensionContext carries no session handle, but ctx.sessionManager is the
// same object as session.sessionManager. Key by it, so a stale or second
// session never answers for the current one. The map lives on globalThis
// because /reload re-imports this file, and the prototype must be wrapped
// only once.
function sessionRegistry(): WeakMap<object, AgentSession> {
  const key = Symbol.for("dotfiles.pi.go.sessions");
  const g = globalThis as Record<symbol, WeakMap<object, AgentSession>>;
  if (g[key]) return g[key];
  const sessions = new WeakMap<object, AgentSession>();
  g[key] = sessions;
  const proto = AgentSession.prototype as unknown as Record<string, unknown>;
  for (const name of ["bindExtensions", "subscribe", "prompt"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    proto[name] = function (this: AgentSession, ...args: unknown[]) {
      sessions.set(this.sessionManager, this);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  return sessions;
}

const sessions = sessionRegistry();

type RunLoop = (messages: AgentMessage[]) => Promise<void>;

const isAbandoned = (m: AgentMessage): boolean =>
  m.role === "assistant" &&
  (m.stopReason === "aborted" || m.stopReason === "error");

function omitAbandoned(session: AgentSession): void {
  const { entries } = session.sessionManager.buildSessionProjection();
  let omitted = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { sourceEntry, messages } = entries[i]!;
    if (messages.length === 0) continue;
    if (!messages.every(isAbandoned)) break;
    session.sessionManager.appendContextEdit(sourceEntry.id, null);
    omitted = true;
  }
  if (omitted) session.refreshContext();
}

// _runAgentPrompt owns retries, compaction, agent_before_settle (lsp feedback)
// and agent_settled (notifier, subagent result file). It opens with one
// agent.prompt(messages) call, so swap that call for continue(), then restore.
async function resume(session: AgentSession, run: RunLoop): Promise<void> {
  const agent = session.agent;
  const shadowed = Object.prototype.hasOwnProperty.call(agent, "prompt");
  const original = agent.prompt;
  const restore = () => {
    if (shadowed) agent.prompt = original;
    else delete (agent as Partial<typeof agent>).prompt;
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

async function go(ctx: ExtensionContext): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent busy, nothing to retrigger", "warning");
    return;
  }
  const session = sessions.get(ctx.sessionManager);
  if (!session) {
    ctx.ui.notify("No live session found for /go", "warning");
    return;
  }
  const run = (session as unknown as { _runAgentPrompt?: RunLoop })
    ._runAgentPrompt;
  if (typeof run !== "function") {
    ctx.ui.notify(
      "/go needs AgentSession._runAgentPrompt, which this pi version lacks",
      "error",
    );
    return;
  }
  omitAbandoned(session);
  const last = session.agent.state.messages.at(-1);
  if (!last) {
    ctx.ui.notify("Nothing to retrigger", "warning");
    return;
  }
  if (last.role === "assistant") {
    ctx.ui.notify("Last reply finished. Send a message instead.", "warning");
    return;
  }
  try {
    await resume(session, run);
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

  pi.registerShortcut("ctrl+alt+g", {
    description: "Re-run the agent on the current transcript",
    handler: (ctx) => go(ctx),
  });
}
