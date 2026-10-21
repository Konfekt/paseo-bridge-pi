import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient } from "./client/main";
import { contributeHarness } from "./client/harness";
import { contributeAccountControls } from "./client/account-controls";
import { contributeBtw } from "./client/btw";
import { contributeWorkflows } from "./client/workflows";
import { contributeThinking } from "./client/thinking";

export default function contribute(client: PluginClientContext) {
	const stops: (() => void)[] = [];
	const cleanup = () => {
		for (const stop of stops.splice(0).reverse()) stop();
	};
	try {
		stops.push(contributeClient(client));
		stops.push(contributeHarness(client));
		stops.push(contributeAccountControls(client));
		stops.push(contributeBtw(client));
		stops.push(contributeWorkflows(client));
		stops.push(contributeThinking(client));
		return cleanup;
	} catch (error) {
		cleanup();
		throw error;
	}
}
