import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url));
const nodes = (x) =>
	!x || typeof x !== "object"
		? []
		: [x, ...[x.props?.children].flat(Infinity).flatMap(nodes)];
const text = (x) =>
	typeof x === "string"
		? x
		: !x || typeof x !== "object"
			? ""
			: [x.props?.children].flat(Infinity).map(text).join(" ");
test("compiled Activity panel renders all features, binds host/session, hides stale errors and cleans up", {
	skip: !process.env.PASEO_PLUGIN_COMPILER,
}, async () => {
	const { compilePlugin } = await import(
		pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
	);
	const { clientBundle } = await compilePlugin({
		client: resolve(root, "index.client.tsx"),
	});
	let panel,
		observer,
		signal,
		pill,
		removed = false;
	let selected = "progress";
	const queries = [],
		calls = [];
	const identity = {
		available: true,
		sessionId: "session",
		runtimeEpoch: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	};
	let status = { data: identity },
		result = {
			data: {
				protocol: 1,
				state: "available",
				sessionId: "session",
				feature: "progress",
				lastUpdated: null,
				stale: false,
				data: { steps: [{ text: "Approve review", status: "blocked" }] },
			},
		};
	const jsx = (type, props) =>
		typeof type === "function" ? type(props) : { type, props };
	const load = (name) => {
		if (name === "@getpaseo/plugin") return { defineRpc: (x) => x };
		if (name === "@getpaseo/plugin/client")
			return {
				useRpc: (contract) => async (input) => {
					contract.input.parse(input);
					calls.push({ contract, input });
					return {};
				},
			};
		if (name === "@getpaseo/plugin/client/react-native")
			return { ScrollView: "ScrollView" };
		if (name === "react-native")
			return { Text: "Text", View: "View", Pressable: "Pressable" };
		if (name === "react/jsx-runtime")
			return { jsx, jsxs: jsx, Fragment: "Fragment" };
		if (name === "react")
			return { useState: () => [selected, (value) => (selected = value)] };
		if (name === "@tanstack/react-query")
			return {
				useQuery: (options) => {
					queries.push(options);
					return {
						isPending: false,
						isError: false,
						refetch: async () => {},
						...(options.queryKey[0] === "pi-activity-identity"
							? status
							: result),
					};
				},
			};
		return require(name);
	};
	const contributeObservability = (0, eval)(clientBundle)(load).default;
	const stop = contributeObservability({
		rpc: async () => ({ available: false }),
		paseo: {
			agents: {
				list: async (o) => {
					signal = o.signal;
					return { subscription: { subscribe: (x) => (observer = x) } };
				},
			},
		},
		addWorkspacePanel: (p) => {
			panel = p;
			return () => (removed = true);
		},
		addComposerPill: (p) => {
			pill = {
				...p,
				remove() {
					this.removed = true;
				},
			};
			return pill;
		},
		openPanel() {},
	});
	const props = {
		agentId: "agent",
		workspaceId: "workspace",
		host: { id: "host" },
		theme: {
			colors: {
				foreground: "white",
				foregroundMuted: "gray",
				statusDanger: "red",
			},
		},
	};
	const render = () => {
		queries.length = 0;
		return panel.Component(props);
	};
	try {
		await new Promise((r) => setImmediate(r));
		observer.snapshot({
			entries: [
				{ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } },
			],
		});
		assert.equal(pill.id, "pi-activity");
		assert.match(text(render()), /Approve review/);
		assert.match(text(render()), /blocked/);
		assert.equal(queries[1].queryKey[1], "host");
		await queries[1].queryFn();
		assert.equal(calls[0].input.expectedSessionId, "session");
		result = { ...result, isError: true };
		assert.doesNotMatch(text(render()), /Approve review/);
		result = {
			data: {
				protocol: 1,
				state: "available",
				sessionId: "old-session",
				feature: "progress",
				data: { steps: [{ text: "STALE", status: "completed" }] },
			},
		};
		assert.doesNotMatch(text(render()), /STALE/);
		selected = "stamp";
		result = {
			data: {
				protocol: 1,
				state: "available",
				sessionId: "session",
				feature: "stamp",
				lastUpdated: null,
				data: {
					records: [
						{
							id: "r",
							role: "assistant",
							timestamp: 1,
							completedAt: 1001,
							provider: "openai",
							model: "gpt-6-astra",
							thinking: "low",
							outcome: "stop",
							usage: { input: 100, output: 10, estimatedCost: 0.1 },
						},
					],
				},
			},
		};
		assert.match(text(render()), /gpt-6-astra/);
		assert.match(text(render()), /Duration 1s/);
		selected = "cache";
		result = {
			data: {
				protocol: 1,
				state: "available",
				sessionId: "session",
				feature: "cache",
				lastUpdated: null,
				data: {
					streaming: false,
					requestNumber: 0,
					latest: null,
					comparison: null,
					session: {
						requestCount: 0,
						promptTokens: 0,
						hitRatePercent: null,
						promptCost: null,
						estimatedSavings: null,
					},
					trend: [],
				},
			},
		};
		assert.match(text(render()), /Cache accounting unavailable/);
		assert.match(text(render()), /Observed cache accounting/);
		assert.doesNotMatch(text(render()), /not a|not independent|not backfilled/);
		status = { data: identity, isError: true };
		assert.equal(queries.length > 0, true);
		assert.doesNotMatch(text(render()), /Active-branch totals/);
		assert.equal(queries[1].enabled, false);
	} finally {
		stop();
	}
	assert.equal(removed, true);
	assert.equal(signal.aborted, true);
	assert.equal(pill.removed, true);
});
