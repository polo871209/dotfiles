// Gate between "pi settled" and "the agent really stopped". pi fires
// agent_settled the moment it has nothing queued, but lsp/feedback starts its
// diagnostics pass on that same event and can send a repair follow-up that
// starts another turn a second later. Anything that reports completion on
// agent_settled (notifier.ts desktop ping and tmux title, subagent.ts result
// file) therefore fires while the agent is about to work again.
//
// A producer opens a claim while that decision is still open and reports on
// release whether it kept the agent running. A consumer waits for the claims
// to clear, then stays quiet when the turn continues, because the next
// agent_settled carries the real completion.
//
// The transport is pi.events, not module state: the loader gives every
// extension its own jiti module graph (moduleCache: false), so two extensions
// that import this file get two copies of everything in it. The event bus is
// the one object they do share, and it is scoped to the session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAIM_CHANNEL = "turn-gate:claim";
const RELEASE_CHANNEL = "turn-gate:release";

export interface SettleOutcome {
  // true = a producer started another turn, so the caller must not report.
  turnContinues: boolean;
}

export type ReleaseSettleClaim = (outcome?: Partial<SettleOutcome>) => void;

// Cap on how long a consumer waits. A producer that crashes or wedges must
// delay the report, never swallow it.
export const SETTLE_GATE_TIMEOUT_MS = 60_000;

interface ClaimEvent {
  id: string;
}
interface ReleaseEvent {
  id: string;
  turnContinues: boolean;
}

const asClaim = (data: unknown): ClaimEvent | null => {
  const e = data as ClaimEvent | undefined;
  return e && typeof e.id === "string" ? e : null;
};

let claimSeq = 0;

// Producer side. Open the claim when the work that can trigger a turn becomes
// possible (an edit), not at agent_settled: consumers read the gate from
// their own agent_settled handler, and handler order across extensions is not
// ours to pick.
export const openSettleClaim = (pi: ExtensionAPI): ReleaseSettleClaim => {
  const id = `${process.pid}:${++claimSeq}`;
  pi.events.emit(CLAIM_CHANNEL, { id } satisfies ClaimEvent);
  let released = false;
  return (outcome) => {
    if (released) return;
    released = true;
    pi.events.emit(RELEASE_CHANNEL, {
      id,
      turnContinues: outcome?.turnContinues === true,
    } satisfies ReleaseEvent);
  };
};

export interface SettleGate {
  // Resolves once no claim is open, or after timeoutMs. Call it
  // synchronously from the agent_settled handler.
  wait(timeoutMs?: number): Promise<SettleOutcome>;
}

// Consumer side. Create it once in the extension factory so the subscription
// exists before any turn runs.
export const createSettleGate = (pi: ExtensionAPI): SettleGate => {
  const open = new Set<string>();
  const waiters = new Set<(outcome: SettleOutcome) => void>();
  let turnContinues = false;

  // Read once, then forget: the flag describes one settle. It survives until
  // somebody reads it, so a release that lands before the consumer waits
  // still counts.
  const consume = (): SettleOutcome => {
    const outcome = { turnContinues };
    turnContinues = false;
    return outcome;
  };

  pi.events.on(CLAIM_CHANNEL, (data) => {
    const claim = asClaim(data);
    if (!claim) return;
    // A new pass starts a new settle: drop whatever the last one reported.
    if (open.size === 0) turnContinues = false;
    open.add(claim.id);
  });

  pi.events.on(RELEASE_CHANNEL, (data) => {
    const claim = asClaim(data);
    if (!claim) return;
    if ((data as ReleaseEvent).turnContinues) turnContinues = true;
    // A release for a claim opened before this gate existed still counts, so
    // do not gate the flush on the id being known.
    open.delete(claim.id);
    if (open.size > 0 || waiters.size === 0) return;
    const outcome = consume();
    for (const waiter of [...waiters]) waiter(outcome);
    waiters.clear();
  });

  return {
    wait: (timeoutMs = SETTLE_GATE_TIMEOUT_MS) => {
      if (open.size === 0) return Promise.resolve(consume());
      return new Promise<SettleOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: SettleOutcome): void => {
          if (timer) clearTimeout(timer);
          waiters.delete(finish);
          resolve(outcome);
        };
        waiters.add(finish);
        timer = setTimeout(() => finish({ turnContinues: false }), timeoutMs);
        timer.unref?.();
      });
    },
  };
};
