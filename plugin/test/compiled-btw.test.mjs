import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
	createBtwEndpoint,
	btwSocketPath,
	writeBtwDescriptor,
} from "../../extension/btw-operator.js";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodes = (x) =>
	!x || typeof x !== "object"
		? []
		: [x, ...[x.props?.children].flat(Infinity).flatMap(nodes)];
const text = (x) =>
	typeof x === "string"
		? x
		: !x || typeof x !== "object"
			? ""
			: [x.props?.children].flat(Infinity).map(text).join("");
test("compiled BTW UI → compiled server → private socket → copied side engine; no draft writes or duplicate dispatch", {
	skip:
		!process.env.PASEO_PLUGIN_COMPILER ||
		!process.env.PI_AGENT_EXTENSIONS_SOURCE,
}, async () => {
	const source = process.env.PI_AGENT_EXTENSIONS_SOURCE;
	const { createJiti } = await import(
		pathToFileURL(
			join(
				source,
				"node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs",
			),
		)
	);
	const { createBtwService } = await createJiti(import.meta.url).import(
		join(source, "btw/service.ts"),
	);
	const dir = await mkdtemp(join(tmpdir(), "btw-ui-")),
		calls = [],
		model = { provider: "openai", id: "gpt-6-luna", api: "openai-responses" };
	const ctx = {
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => [
				{
					type: "message",
					message: { role: "user", content: "Parent context" },
				},
			],
		},
		modelRegistry: {
			getAvailable: () => [model],
			find: () => model,
			streamSimple(selected, context, options) {
				let finish;
				const result = new Promise((resolve) => (finish = resolve));
				const response = {
					role: "assistant",
					content: [{ type: "text", text: "Finished answer" }],
					stopReason: "stop",
					usage: {},
					timestamp: 1,
				};
				calls.push({
					selected,
					context,
					options,
					finish: () => finish(response),
				});
				options.signal.addEventListener(
					"abort",
					() => finish({ ...response, stopReason: "aborted" }),
					{ once: true },
				);
				return {
					[Symbol.asyncIterator]: async function* () {
						yield { type: "text_delta", delta: "Live text" };
						await result;
					},
					result: () => result,
				};
			},
		},
	};
	const service = createBtwService(ctx),
		identity = {
			agentId: "agent",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
			runtimeEpoch: randomUUID(),
			capability: "a".repeat(64),
		};
	const pipe = join(dir, "bridge"),
		endpoint = createBtwEndpoint(pipe, () => ({
			btwIdentity: () => identity,
			btw: async (request) => service.handle(request),
		}));
	let stop = () => {};
	try {
		const probe = connect(btwSocketPath(pipe));
		await once(probe, "connect");
		probe.destroy();
		writeBtwDescriptor(join(dir, ".pi", "paseo-bridge"), {
			version: 1,
			socketPath: btwSocketPath(pipe),
			...identity,
		});
		const { compilePlugin } = await import(
			pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
		);
		const { clientBundle, serverBundle } = await compilePlugin({
			client: resolve(root, "index.client.tsx"),
			server: resolve(root, "index.server.ts"),
		});
		const handlers = new Map();
		const backend = (0, eval)(serverBundle)((name) =>
			name === "@getpaseo/plugin"
				? { defineRpc: (x) => x }
				: name === "node:os"
					? { ...require(name), homedir: () => dir }
					: require(name),
		).default;
		backend({
			handle: (contract, handler) =>
				handlers.set(contract.name, { contract, handler }),
			registerUsageSource: () => () => {},
			before: () => () => {},
		});
		let wrongWorkspace = false,
			loseReply = false;
		const requests = [],
			pendingControls = [];
		const handlerContext = {
			paseo: {
				agents: {
					ref: () => ({
						refresh: async () => ({
							agent: {
								id: "agent",
								workspaceId: wrongWorkspace ? "other" : "workspace",
								provider: "pi",
							},
						}),
					}),
				},
			},
		};
		async function rpc(contract, input) {
			const registered = handlers.get(contract.name);
			registered.contract.input.parse(input);
			requests.push({ name: contract.name, input });
			let done;
			if (contract.name === "btw_control")
				pendingControls.push(new Promise((resolve) => (done = resolve)));
			try {
				const result = await registered.handler(input, handlerContext);
				registered.contract.output.parse(result);
				if (loseReply && contract.name === "btw_control")
					throw Error("lost reply");
				return result;
			} finally {
				done?.();
			}
		}
		let hook = 0,
			options,
			data,
			isError = false;
		const states = [],
			subscriptions = [],
			panels = new Map(),
			pills = [],
			clipboard = [];
		const query = {
			get data() {
				return data;
			},
			get isPending() {
				return !data;
			},
			get isError() {
				return isError;
			},
			isFetching: false,
			refetch: async () => {
				const o = options;
				try {
					data = await o.queryFn();
					isError = false;
				} catch {
					isError = true;
				}
				return { data, isError };
			},
		};
		const jsx = (type, props, key) => {
			assert.ok(
				typeof type === "string" || typeof type === "function",
				`Missing host UI export ${type}`,
			);
			return typeof type === "function" ? type(props) : { type, props, key };
		};
		const load = (name) => {
			if (name === "@getpaseo/plugin") return { defineRpc: (x) => x };
			if (name === "@getpaseo/plugin/client")
				return { useRpc: (contract) => (input) => rpc(contract, input) };
			if (name === "@getpaseo/plugin/client/react-native")
				return {
					ScrollView: "ScrollView",
					TextInput: "TextInput",
					copyText: async (value) => clipboard.push(value),
				};
			if (name === "@getpaseo/plugin/client/ui")
				return {
					SettingsCard: "SettingsCard",
					SettingsSection: "SettingsSection",
					SettingsSelect: "SettingsSelect",
				};
			if (name === "react-native")
				return { View: "View", Text: "Text", Pressable: "Pressable" };
			if (name === "react/jsx-runtime")
				return { jsx, jsxs: jsx, Fragment: "Fragment" };
			if (name === "react")
				return {
					useState: (initial) => {
						const i = hook++;
						if (!(i in states))
							states[i] = typeof initial === "function" ? initial() : initial;
						return [
							states[i],
							(value) =>
								(states[i] =
									typeof value === "function" ? value(states[i]) : value),
						];
					},
				};
			if (name === "@tanstack/react-query")
				return {
					useQuery: (o) => {
						options = o;
						return query;
					},
				};
			return require(name);
		};
		const contribute = (0, eval)(clientBundle)(load).default;
		stop = contribute({
			rpc: async () => ({ available: false }),
			paseo: {
				config: { get: async () => ({ config: { plugins: { "paseo-accounts": { enabled: true } } } }) },
				agents: {
					list: async () => ({
						subscription: { subscribe: (s) => subscriptions.push(s) },
					}),
				},
			},
			addScreen: () => () => {},
			openScreen() {},
			addWorkspacePanel: (p) => {
				panels.set(p.id, p);
				return () => panels.delete(p.id);
			},
			addComposerPill: (p) => {
				const entry = {
					...p,
					removed: false,
					remove() {
						this.removed = true;
					},
					update() {},
				};
				pills.push(entry);
				return entry;
			},
			addHeaderButton: () => ({ remove() {}, update() {} }),
			openPanel() {},
		});
		await tick();
		for (const s of subscriptions)
			s.snapshot({
				entries: [
					{ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } },
				],
			});
		assert.ok(pills.find((p) => p.id === "pi-btw"));
		assert.ok(panels.has("pi-btw"));
		const props = {
			agentId: "agent",
			workspaceId: "workspace",
			host: { id: "test-host" },
			theme: {
				colors: {
					foreground: "#fff",
					foregroundMuted: "#aaa",
					accent: "#08f",
					surface0: "#111",
					surface1: "#222",
					border: "#444",
					statusWarning: "#fa0",
				},
			},
		};
		const render = () => {
			hook = 0;
			return panels.get("pi-btw").Component(props);
		};
		const button = (tree, label) => {
			const node = nodes(tree).find(
				(n) => n.type === "Pressable" && text(n) === label,
			);
			assert.ok(node, label);
			return node;
		};
		let tree = render();
		await query.refetch();
		tree = render();
		const input = nodes(tree).find((n) => n.type === "TextInput");
		input.props.onChangeText("Explain this");
		tree = render();
		const ask = button(tree, "Ask BTW");
		ask.props.onPress();
		ask.props.onPress();
		await pendingControls.at(-1);
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(states[0].busy, false);
		tree = render();
		await query.refetch();
		tree = render();
		assert.match(text(tree), /Live text/);
		assert.match(text(tree), /Explain this/);
		assert.equal(calls[0].selected.id, "gpt-6-luna");
		assert.notEqual(calls[0].options.sessionId, "session");
		calls[0].finish();
		await tick();
		await query.refetch();
		tree = render();
		assert.match(text(tree), /Finished answer/);
		button(tree, "Copy answer").props.onPress();
		await tick();
		assert.deepEqual(clipboard, ["Finished answer"]);
		assert.ok(
			requests.every((r) => ["btw_status", "btw_control"].includes(r.name)),
			"no main prompt/draft API used",
		);
		nodes(tree)
			.find((n) => n.type === "TextInput")
			.props.onChangeText("Second question");
		tree = render();
		loseReply = true;
		button(tree, "Send follow-up").props.onPress();
		await pendingControls.at(-1);
		await tick();
		tree = render();
		assert.match(text(tree), /may have completed/);
		assert.equal(button(tree, "Send follow-up").props.disabled, true);
		assert.equal(calls.length, 2);
		const count = requests.filter((r) => r.name === "btw_control").length;
		states.length = 0;
		tree = render();
		assert.equal(
			button(tree, "Send follow-up").props.disabled,
			true,
			"uncertain lock survives panel remount",
		);
		assert.equal(
			requests.filter((r) => r.name === "btw_control").length,
			count,
			"no automatic retry",
		);
		loseReply = false;
		await query.refetch();
		tree = render();
		button(tree, "I reviewed the refreshed status").props.onPress();
		calls[1].finish();
		await tick();
		await query.refetch();
		tree = render();
		wrongWorkspace = true;
		const mutation = requests.find((r) => r.name === "btw_control");
		await assert.rejects(
			rpc(handlers.get("btw_control").contract, mutation.input),
			/workspace/,
		);
		assert.equal(calls.length, 2);
		stop();
		stop = () => {};
		assert.ok(pills.every((p) => p.removed));
		assert.equal(panels.size, 0);
	} finally {
		stop();
		service.dispose();
		endpoint.close();
		await rm(dir, { recursive: true, force: true });
	}
});
