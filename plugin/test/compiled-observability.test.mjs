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
	typeof x === "number"
		? String(x)
		: typeof x === "string"
			? x
			: !x || typeof x !== "object"
				? ""
				: [x.props?.children].flat(Infinity).map(text).join(" ");
test("native Activity dashboard shows every section, accessible meters and expandable detail with isolated session queries", {
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
		removed = false,
		hook = 0,
		refreshes = 0;
	const states = [],
		queries = [],
		calls = [];
	const identity = {
		available: true,
		sessionId: "session",
		runtimeEpoch: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	};
	let status = { data: identity };
	const snap = (feature, data) => ({
		data: {
			protocol: 1,
			state: "available",
			sessionId: "session",
			feature,
			lastUpdated: null,
			stale: false,
			data,
		},
	});
	const results = {
		progress: snap("progress", {
			steps: [
				{ text: "Shipped", status: "completed" },
				{ text: "Approve review", status: "blocked" },
				{ text: "Implement UI", status: "in_progress" },
				{ text: "Follow up", status: "pending" },
				{ text: "Later", status: "pending" },
			],
		}),
		stamp: snap("stamp", {
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
					usage: { input: 1234, output: 10, estimatedCost: 0.1 },
				},
			],
		}),
		cache: snap("cache", {
			streaming: false,
			requestNumber: 1,
			latest: {
				provider: "openai",
				model: "gpt-6-astra",
				hitRatePercent: 75,
				input: 250,
				cacheRead: 750,
				cacheWrite: 0,
			},
			comparison: {
				requestStartGapMs: 2000,
				rebilledTokens: 0,
				estimatedMissPremium: 0,
			},
			session: {
				requestCount: 2,
				promptTokens: 2000,
				hitRatePercent: 75,
				promptCost: 0.1,
				estimatedSavings: 0.02,
			},
			trend: [70, 75],
		}),
	};
	const jsx = (type, props, key) => {
		assert.ok(
			typeof type === "string" || typeof type === "function",
			`Missing host component ${type}`,
		);
		return typeof type === "function" ? type(props) : { type, props, key };
	};
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
		if (name === "@getpaseo/plugin/client/ui")
			return {
				SettingsSection: (props) => ({
					type: "SettingsSection",
					props: {
						...props,
						children: [props.title, props.trailing, props.children],
					},
				}),
				SettingsCard: (props) => ({ type: "SettingsCard", props }),
			};
		if (name === "@getpaseo/plugin/client/react-native")
			return { ScrollView: "ScrollView" };
		if (name === "react-native")
			return { Text: "Text", View: "View", Pressable: "Pressable" };
		if (name === "react/jsx-runtime")
			return { jsx, jsxs: jsx, Fragment: "Fragment" };
		if (name === "react")
			return {
				useState: (initial) => {
					const index = hook++;
					if (!(index in states)) states[index] = initial;
					return [states[index], (value) => (states[index] = value)];
				},
			};
		if (name === "@tanstack/react-query")
			return {
				useQuery: (options) => {
					queries.push(options);
					return {
						isPending: false,
						isError: false,
						refetch: async () => {
							refreshes++;
						},
						...(options.queryKey[0] === "pi-activity-identity"
							? status
							: results[options.queryKey.at(-1)]),
					};
				},
			};
		return require(name);
	};
	const contribute = (0, eval)(clientBundle)(load).default;
	const stop = contribute({
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
	const colors = {
		foreground: "#fff",
		foregroundMuted: "#aaa",
		statusDanger: "#f00",
		statusWarning: "#fa0",
		statusSuccess: "#0f0",
		accent: "#08f",
		surface0: "#111",
		surface1: "#222",
		surface2: "#333",
		border: "#444",
	};
	const props = {
		agentId: "agent",
		workspaceId: "workspace",
		host: { id: "host" },
		theme: { colors },
	};
	const render = () => {
		queries.length = 0;
		hook = 0;
		return panel.Component(props);
	};
	const press = (tree, label) => {
		const node = nodes(tree).find(
			(n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
		);
		assert.ok(node, label);
		node.props.onPress();
	};
	try {
		await new Promise((r) => setImmediate(r));
		observer.snapshot({
			entries: [
				{ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } },
			],
		});
		assert.equal(pill.id, "pi-activity");
		let tree = render();
		assert.equal(
			nodes(tree).filter((n) => n.type === "SettingsSection").length,
			3,
		);
		assert.equal(queries.length, 4);
		assert.match(text(tree), /Approve review/);
		assert.match(text(tree), /Observed cache accounting/);
		assert.match(text(tree), /gpt-6-astra/);
		assert.match(text(tree), /1\s*\/\s*5\s*complete/);
		assert.doesNotMatch(text(tree), /Input tokens/);
		assert.equal(
			nodes(tree).filter((n) => n.props?.accessibilityRole === "tab").length,
			0,
		);
		const meters = nodes(tree).filter(
			(n) => n.props?.accessibilityRole === "progressbar",
		);
		assert.deepEqual(
			meters.map((n) => n.props.accessibilityValue.now),
			[20, 75],
		);
		assert.ok(
			text(tree).indexOf("Implement UI") < text(tree).indexOf("Approve review"),
		);
		press(tree, "Cache details");
		tree = render();
		assert.match(text(tree), /Session requests/);
		assert.match(text(tree), /Request gap/);
		press(tree, "Response details r");
		tree = render();
		assert.match(text(tree), /Input tokens/);
		assert.match(text(tree), /1,234/);
		assert.doesNotMatch(text(tree), /Shipped/);
		press(tree, "Show all 5 steps");
		tree = render();
		assert.match(text(tree), /Shipped/);
		press(tree, "Refresh");
		assert.equal(refreshes, 4);
		for (const query of queries.slice(1)) {
			assert.equal(query.queryKey[1], "host");
			await query.queryFn();
		}
		assert.deepEqual(
			calls.map((c) => c.input.feature),
			["progress", "cache", "stamp"],
		);
		assert.ok(calls.every((c) => c.input.expectedSessionId === "session"));
		results.progress.isError = true;
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review/);
		assert.match(text(tree), /gpt-6-astra/);
		delete results.progress.isError;
		results.cache = snap("cache", {
			...results.cache.data.data,
			latest: null,
			comparison: null,
			trend: [],
			session: { ...results.cache.data.data.session, hitRatePercent: null },
		});
		tree = render();
		const unknown = nodes(tree).find(
			(n) => n.props?.accessibilityLabel === "Cache hit rate",
		);
		assert.equal(unknown.props.accessibilityValue.now, undefined);
		assert.equal(unknown.props.accessibilityValue.text, "Unavailable");
		status = {
			data: {
				...identity,
				sessionId: "new-session",
				runtimeEpoch: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
			},
		};
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review|gpt-6-astra/);
		assert.ok(nodes(tree).some((n) => n.key?.includes("new-session:bbbbbbbb")));
		status = { data: identity, isError: true };
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review|gpt-6-astra/);
		assert.ok(queries.slice(1).every((q) => q.enabled === false));
		assert.doesNotMatch(text(tree), /not a|not independent/);
	} finally {
		stop();
	}
	assert.equal(removed, true);
	assert.equal(signal.aborted, true);
	assert.equal(pill.removed, true);
});
