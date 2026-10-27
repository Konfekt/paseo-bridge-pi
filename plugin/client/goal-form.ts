/** UI-only draft state. Never starts a goal or infers permission to run a child. */
export type GoalFormSnapshot = {
  objective: string;
  budget: string;
  objectiveError: string | null;
  budgetError: string | null;
  canSubmit: boolean;
  tokenBudget: number | undefined;
};

export function openGoalForm(seed: { objective?: string; tokenBudget?: number | null } = {}) {
  let objective = seed.objective ?? "";
  let budget = seed.tokenBudget == null ? "" : String(seed.tokenBudget);
  let closed = false;
  const listeners = new Set<() => void>();
  function derive(): GoalFormSnapshot {
    const trimmed = objective.trim();
    const amount = budget.trim() ? Number(budget.trim()) : undefined;
    const objectiveError = !trimmed ? null : trimmed.length > 4000 ? "Use at most 4,000 characters" : null;
    const budgetError = amount !== undefined && (!/^\d+$/.test(budget.trim()) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000)
      ? "Use a whole number from 1 to 1,000,000, or leave empty for unlimited" : null;
    return { objective, budget, objectiveError, budgetError, tokenBudget: budgetError ? undefined : amount,
      canSubmit: !!trimmed && !objectiveError && !budgetError };
  }
  let state = derive();
  function publish() {
    if (closed) return;
    state = derive();
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { if (!closed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    setObjective(value: string) { if (!closed) { objective = value; publish(); } },
    setBudget(value: string) { if (!closed) { budget = value; publish(); } },
    close() { closed = true; listeners.clear(); },
  };
}
