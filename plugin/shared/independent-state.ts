/** Runtime-bound plugin controls become available only after the first real prompt. */
export function isDormantIndependentAgent(agent: unknown): boolean {
  return !!agent && typeof agent === "object"
    && (agent as { runtimeInfo?: { extra?: { independentDormant?: boolean } } }).runtimeInfo?.extra?.independentDormant === true;
}
