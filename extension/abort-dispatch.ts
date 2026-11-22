export type AbortContext = {
  abort(): void;
  isIdle(): boolean;
};

type AbortWaitOptions = {
  /** How long to wait for Pi to settle before acknowledging anyway. */
  acknowledgeWithinMs?: number;
  /** Bridge/session lifetime, not the active turn's abort signal. */
  signal?: AbortSignal;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type AbortOutcome = {
  /** Pi was idle when the abort was acknowledged. */
  settled: boolean;
  /** Resolves once Pi is idle; rejects when the bridge lifetime ends first. */
  idle: Promise<void>;
};

/**
 * Paseo refuses to stop or replace an agent when the provider does not answer
 * its interrupt within two seconds. Acknowledge well inside that window.
 */
export const ABORT_ACKNOWLEDGE_MS = 1500;
const DEFAULT_POLL_MS = 25;

// The idle watch must never keep the process alive on its own.
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref?.());
}

/**
 * Pi's extension ctx.abort() is fire-and-forget, while the underlying
 * AgentSession.abort() waits for the active tool and turn to settle. A tool
 * whose cleanup ignores cancellation can keep Pi busy for much longer than
 * Paseo waits for an answer. Dispatch the abort, wait briefly for Pi to become
 * idle, then acknowledge either way and expose the remaining settlement, so
 * the caller can hold later work until Pi is really idle.
 */
export async function abortAndAcknowledge(
  context: AbortContext | null | undefined,
  options: AbortWaitOptions = {},
): Promise<AbortOutcome> {
  if (!context) throw new Error("Pi session context is unavailable; cancellation was not dispatched");
  const signal = options.signal;
  const requireLive = () => {
    if (signal?.aborted) throw new Error("Pi cancellation context closed before settlement");
  };
  requireLive();
  context.abort();
  requireLive();

  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const idle = (async () => {
    while (true) {
      // Check lifetime before idle: an invalidated context must not report a
      // successor session's idle state as this cancellation's settlement.
      requireLive();
      if (context.isIdle()) return;
      await sleep(pollMs);
    }
  })();
  // Callers that only need the acknowledgement must not see a late rejection.
  idle.catch(() => {});

  const acknowledgeWithinMs = options.acknowledgeWithinMs ?? ABORT_ACKNOWLEDGE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"pending">(resolve => { timer = setTimeout(() => resolve("pending"), acknowledgeWithinMs); });
  try {
    const result = await Promise.race([idle.then(() => "idle" as const), deadline]);
    return { settled: result === "idle", idle };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait up to `timeoutMs` for a pending cancellation to settle. Returns false
 * when Pi is still busy at the deadline.
 */
export async function waitForSettlement(idle: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([idle.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
