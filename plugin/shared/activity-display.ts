export type ProgressStep = {
	text: string;
	status: "pending" | "in_progress" | "completed" | "blocked";
};
export function progressSummary(steps: readonly ProgressStep[]) {
	const completed = steps.filter((step) => step.status === "completed").length;
	return {
		completed,
		total: steps.length,
		blocked: steps.filter((step) => step.status === "blocked").length,
		percent: steps.length ? (completed / steps.length) * 100 : null,
	};
}
export function prioritizeSteps(steps: readonly ProgressStep[]) {
	const rank = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
	return steps
		.map((step, index) => ({ step, index }))
		.sort(
			(a, b) => rank[a.step.status] - rank[b.step.status] || a.index - b.index,
		);
}
export function percent(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(100, Math.max(0, value))
		: null;
}
export function count(value: number | null | undefined) {
	return value == null || !Number.isFinite(value)
		? "—"
		: Math.round(value).toLocaleString();
}
export function cost(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value) || value < 0) return "—";
	if (value === 0) return "$0";
	return value < 0.001 ? "<$0.001" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
export function duration(ms: number | null | undefined) {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
	if (ms < 3600000)
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
