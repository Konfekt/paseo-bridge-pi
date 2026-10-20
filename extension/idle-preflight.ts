export const IDLE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
// Paseo classifies native prompt failures containing "aborted" as cancellation.
export const IDLE_PROMPT_CANCELLED = "Request was aborted: prompt cancelled.";

export type IdlePreflightCapability = {
  ready: boolean;
  check(signal?: AbortSignal): Promise<"continue" | "cancel">;
};
export type IdlePreflightResult = "unavailable" | "continue" | "cancel" | "error";

/** Missing optional extension is a no-op; failed or aborted checks never send a prompt. */
export async function checkIdlePreflight(
  capability: unknown,
  signal: AbortSignal,
): Promise<IdlePreflightResult> {
  if (signal.aborted) return "cancel";
  if (capability == null) return "unavailable";
  if (typeof capability !== "object" || !("ready" in capability) || !("check" in capability)) return "error";
  const candidate = capability as IdlePreflightCapability;
  if (candidate.ready !== true || typeof candidate.check !== "function") return "error";
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"cancel">((resolve) => {
    abortListener = () => resolve("cancel");
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const decision = await Promise.race([candidate.check(signal), aborted]);
    if (signal.aborted) return "cancel";
    return decision === "continue" ? "continue" : "cancel";
  } catch {
    return "error";
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

/** Apply the bridge handshake and invoke dispatch only when safe. */
export async function dispatchAfterIdlePreflight<T>(
  capability: unknown,
  signal: AbortSignal,
  dispatch: () => Promise<T>,
): Promise<{ outcome: IdlePreflightResult; dispatched: boolean; value?: T }> {
  const outcome = await checkIdlePreflight(capability, signal);
  if (signal.aborted) return { outcome: "cancel", dispatched: false };
  if (outcome === "cancel" || outcome === "error") return { outcome, dispatched: false };
  return { outcome, dispatched: true, value: await dispatch() };
}
