export type AbortContext = {
  abort(): void;
  isIdle(): boolean;
};

type AbortWaitOptions = {
  timeoutMs?: number;
  /** Bridge/session lifetime, not the active turn's abort signal. */
  signal?: AbortSignal;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_POLL_MS = 25;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Pi's extension ctx.abort() is intentionally fire-and-forget even though the
 * underlying AgentSession.abort() waits for the active tool and turn to settle.
 * Like native RPC abort, acknowledge only after the extension context is idle.
 * A caller's response deadline does not mean cancellation was refused: tool
 * cleanup may still be running. Keep waiting by default rather than returning a
 * failed response for an abort that was already dispatched.
 */
export async function abortAndWaitForIdle(
  context: AbortContext | null | undefined,
  options: AbortWaitOptions = {},
): Promise<void> {
  if (!context) throw new Error("Pi session context is unavailable; cancellation was not dispatched");

  const signal = options.signal;
  const requireLive = () => {
    if (signal?.aborted) throw new Error("Pi cancellation context closed before settlement");
  };
  requireLive();
  context.abort();
  requireLive();
  if (context.isIdle()) return;

  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Check lifetime before idle: an invalidated context must not acknowledge a
    // successor session, even if its isIdle closure now observes that session.
    requireLive();
    if (context.isIdle()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Pi did not become idle after cancellation");
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
