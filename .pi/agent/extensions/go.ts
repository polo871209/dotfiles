// pi exposes no public "continue" from idle (every public path appends a
// message), so this reaches the live AgentSession. Two internals remain:
// the session lookup below and AgentSession._startRun.
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

type GoMessage = Extract<AgentMessage, { role: "custom" }>;
type StartRun = (trigger: {
  messageType: "custom";
  message: GoMessage;
}) => Promise<void>;

function omitAbandoned(session: AgentSession): void {
  const { entries } = session.sessionManager.buildSessionProjection();
  let omitted = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { sourceEntry, messages } = entries[i]!;
    if (messages.length === 0) continue;
    if (
      !messages.every(
        (m: AgentMessage): boolean =>
          m.role === "assistant" &&
          (m.stopReason === "aborted" || m.stopReason === "error"),
      )
    )
      break;
    session.sessionManager.appendContextEdit(sourceEntry.id, null);
    omitted = true;
  }
  if (omitted) session.refreshContext();
}

// pi exposes no resume, and its private _startRun needs a starting message, so swap the marker for what pi queued or continue().
async function resume(session: AgentSession, start: StartRun): Promise<void> {
  const agent = session.agent;
  const marker: GoMessage = {
    role: "custom",
    customType: "go",
    content: [],
    display: false,
    timestamp: Date.now(),
  };
  const shadowed = Object.prototype.hasOwnProperty.call(agent, "prompt");
  const ownPrompt = agent.prompt;
  const restore = () => {
    if (shadowed) agent.prompt = ownPrompt;
    else delete (agent as Partial<typeof agent>).prompt;
  };
  agent.prompt = ((input: AgentMessage | AgentMessage[]) => {
    restore();
    const rest = [input].flat().filter((m) => m !== marker);
    return rest.length > 0 ? agent.prompt(rest) : agent.continue();
  }) as typeof agent.prompt;
  try {
    await start.call(session, { messageType: "custom", message: marker });
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
  const start = (session as unknown as { _startRun?: StartRun })._startRun;
  if (typeof start !== "function") {
    ctx.ui.notify(
      "/go needs AgentSession._startRun, which this pi version lacks",
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
    await resume(session, start);
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
