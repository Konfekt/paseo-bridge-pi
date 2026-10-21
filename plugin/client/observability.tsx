import type {
	PluginClientContext,
	PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import { ObservabilityPanel } from "./activity-dashboard";
import { isDormantIndependentAgent } from "../shared/independent-state";
export { ObservabilityPanel } from "./activity-dashboard";

/** One Activity destination; no polling until the host mounts its dashboard. */
export function contributeObservability(client: PluginClientContext) {
	const entries = new Map<
		string,
		{ workspace: string; button: PluginButtonRegistration }
	>();
	const lifetime = new AbortController();
	let stopped = false;
	const dispose = client.addWorkspacePanel({
		id: "pi-activity",
		title: "Activity",
		icon: "Activity",
		context: "agent",
		locations: ["workspace"],
		Component: ObservabilityPanel,
	});
	const remove = (id: string) => {
		entries.get(id)?.button.remove();
		entries.delete(id);
	};
	const register = (agent: {
		id: string;
		workspaceId?: string | null;
		provider?: string;
		archivedAt?: string | null;
	}) => {
		if (stopped) return;
		if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId || isDormantIndependentAgent(agent)) {
			remove(agent.id);
			return;
		}
		if (entries.get(agent.id)?.workspace === agent.workspaceId) return;
		remove(agent.id);
		const workspaceId = agent.workspaceId;
		entries.set(agent.id, {
			workspace: workspaceId,
			button: client.addComposerPill({
				id: "pi-activity",
				agentId: agent.id,
				workspaceId,
				button: {
					label: "Activity",
					title: "Activity",
					icon: "Activity",
					behavior: {
						kind: "action",
						onPress: () =>
							client.openPanel("pi-activity", {
								agentId: agent.id,
								workspaceId,
							}),
					},
				},
			}),
		});
	};
	void client.paseo.agents
		.list({ subscribe: {}, signal: lifetime.signal })
		.then(({ subscription }) => {
			if (stopped) return;
			subscription.subscribe({
				snapshot: ({ entries: agents }) => {
					const ids = new Set(agents.map(({ agent }) => agent.id));
					for (const id of entries.keys()) if (!ids.has(id)) remove(id);
					for (const { agent } of agents) register(agent);
				},
				update: (message) => {
					if (message.type === "agent_update") {
						if (message.payload.kind === "remove")
							remove(message.payload.agentId);
						else register(message.payload.agent);
					}
				},
			});
		})
		.catch((error) => {
			if (!stopped)
				console.error("Pi Activity subscription unavailable", error);
		});
	return () => {
		stopped = true;
		lifetime.abort();
		for (const id of entries.keys()) remove(id);
		dispose();
	};
}
