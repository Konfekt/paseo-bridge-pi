export type WorkSection = "jobs" | "agents" | "worktrees" | "goals";
export type WorkViewState = {
	section?: WorkSection;
	completed: boolean;
	scroll: Map<string, number>;
};

/** One instance per host-scoped client contribution. Closing a native tab does
 * not dispose this UI state, and this store has no work-control capabilities. */
export function createWorkTabState() {
	const selected = new Map<string, string>();
	const views = new Map<string, WorkViewState>();
	const listeners = new Set<() => void>();
	const key = (workspaceId: string, agentId: string) => JSON.stringify([workspaceId, agentId]);
	return {
		selected(workspaceId: string) { return selected.get(workspaceId); },
		select(workspaceId: string, agentId: string) {
			if (selected.get(workspaceId) === agentId) return;
			selected.set(workspaceId, agentId);
			listeners.forEach(listener => listener());
		},
		view(workspaceId: string, agentId: string) {
			const id = key(workspaceId, agentId);
			let view = views.get(id);
			if (!view) {
				view = { completed: false, scroll: new Map() };
				views.set(id, view);
			}
			return view;
		},
		remove(workspaceId: string, agentId: string) {
			views.delete(key(workspaceId, agentId));
			if (selected.get(workspaceId) !== agentId) return;
			selected.delete(workspaceId);
			listeners.forEach(listener => listener());
		},
		refresh() { listeners.forEach(listener => listener()); },
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}
