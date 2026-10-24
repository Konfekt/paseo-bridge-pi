import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, "PASEO_PLUGIN_COMPILER is required; Worktree filter tests must execute");
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("compiled Worktrees defaults to this session, toggles full inventory, groups visible rows and preserves path actions", {}, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, "index.client.tsx") });
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const colors = { foreground: "#fff", foregroundMuted: "#aaa", statusDanger: "#f00", surface0: "#111", surface1: "#222", surface2: "#333", border: "#444", accent: "#0af", statusWarning: "#fa0", statusSuccess: "#0f0", accentForeground: "#000" };
  let snapshot;
  let sessionId = "session-a";
  let commands = [];
  const data = () => ({ available: true, enabled: true, sessionId, runtimeEpoch: "runtime", snapshot: { ...snapshot, serviceEpoch: "service" } });
  let queryPromise;
  let hookIndex = 0;
  const hookStates = [];
  const elements = [];
  const load = name => {
    if (name === "@getpaseo/plugin") return { defineRpc: contract => contract };
    if (name === "zod") { const schema = new Proxy({}, { get: () => (...args) => schema }); return { z: new Proxy({}, { get: () => (...args) => schema }) }; }
    if (name === "@getpaseo/plugin/client/ui") return { SettingsCard: "SettingsCard", SettingsSection: "SettingsSection", SettingsSelect: "SettingsSelect", SettingsAction: props => jsx("SettingsAction", props) };
    if (name === "@getpaseo/plugin/client") return { useRpc: contract => contract.name === "workflows_status" ? async () => data() : async value => { commands.push(value); return { accepted: true }; } };
    if (name === "@getpaseo/plugin/client/react-native") return { ScrollView: "ScrollView", TextInput: "TextInput" };
    if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable" };
    if (name === "react") return { useEffect() {}, useRef: initial => ({ current: initial }), useState: initial => { const index = hookIndex++; hookStates[index] ??= typeof initial === "function" ? initial() : initial; return [hookStates[index], next => { hookStates[index] = typeof next === "function" ? next(hookStates[index]) : next; }]; } };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@tanstack/react-query") return { useQuery: options => { queryPromise ??= options.queryFn(); return { data: data(), isError: false, isFetching: false, refetch: async () => {} }; }, useMutation: () => ({ mutate() {} }) };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  let worktrees;
  const cleanup = contribute({
    paseo: { config: { get: async () => ({ config: {} }) }, agents: { list: async () => ({ subscription: { subscribe() {} } }) } },
    rpc: async () => ({}), addWorkspacePanel: value => { if (value.id === "pi-worktrees") worktrees = value; return () => {}; }, addScreen: () => () => {}, addComposerPill: () => ({ update() {}, remove() {} }),
  });
  async function renderAndNodes() {
    elements.length = 0;
    hookIndex = 0;
    const tree = worktrees.Component({ host: { id: "host" }, agentId: "agent", workspaceId: "workspace", theme: { colors }, navigation: { openWorkspace() {} } });
    await queryPromise;
    queryPromise = undefined;
    const visit = node => { if (!node || typeof node !== "object") return; elements.push(node); for (const child of [node.props?.children].flat(Infinity)) visit(child); };
    visit(tree);
    return elements;
  }
  const textOf = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : "";
  const makeTree = (path, createdInSession, repositoryPath = "/repo", extra = {}) => ({ path, createdInSession, repositoryPath, repositoryLabel: repositoryPath, branch: path, head: "abcdef", main: false, current: false, locked: false, stale: false, detached: false, changedFiles: 0, ...extra });
  const idle = { protocol: 1, sessionId: "session-a", serviceEpoch: "service", cwd: "/repo", model: null, busy: false, idle: true, notice: null, operationId: null, operationAction: null, protectedPaths: [], dialog: null, worktreeError: null, worktreeLoading: false, worktreeRepositoryCount: 1, worktreeContainer: false, goal: null, completedGoals: [], lastCompletion: null, worktree: null, worktrees: [] };
  try {
    snapshot = { ...idle, worktrees: [makeTree("/repo/other", false), makeTree("/second/ours", true, "/second"), makeTree("/second/also-ours", true, "/second"), makeTree("/repo/ours", true)] };
    let nodes = await renderAndNodes();
    nodes.find(node => textOf(node) === "Connect current session")?.props.onPress();
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node).includes("/repo/ours")));
    assert.ok(!nodes.some(node => textOf(node).includes("/repo/other")));
    assert.ok(nodes.some(node => textOf(node) === "Show all"));
    assert.ok(nodes.some(node => textOf(node) === "Main" ) === false);
    const headings = nodes.filter(node => node.props?.accessibilityRole === "header").map(textOf);
    assert.deepEqual(headings, ["/second", "/repo"], "filtered-out neighbor does not break visible repository grouping");
    snapshot = { ...snapshot, worktreeError: "One repository could not be read; showing the rest." };
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node) === "Show all"), "partial inventory warnings must not hide the view toggle");
    nodes.find(node => textOf(node) === "Show all").props.onPress();
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node).includes("/repo/other")));
    snapshot = { ...snapshot, worktreeError: null };
    assert.ok(nodes.some(node => textOf(node) === "Show ours"));
    assert.ok(nodes.some(node => textOf(node).includes("/repo/other") && node.type === "Pressable"), "worktree rows remain selectable for existing actions");
    nodes.find(node => textOf(node) === "Show ours").props.onPress();
    nodes = await renderAndNodes();
    assert.ok(!nodes.some(node => textOf(node).includes("/repo/other")));
    // Missing createdInSession metadata is treated as not ours.
    snapshot = { ...snapshot, worktrees: [makeTree("/repo/legacy", undefined)] };
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node) === "No session-created worktrees"));
    assert.ok(nodes.some(node => textOf(node) === "Show all"), "empty ours view still offers full inventory");
    nodes.find(node => textOf(node) === "Show all").props.onPress();
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node).includes("/repo/legacy")));
    snapshot = { ...snapshot, worktrees: [] };
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node) === "No additional worktrees"), "empty all view keeps its original wording");
    assert.ok(nodes.some(node => textOf(node) === "Show ours"), "empty full inventory can still switch back");
    // New session clears remembered Show all state.
    sessionId = "session-b";
    snapshot = { ...snapshot, sessionId, worktrees: [makeTree("/repo/not-ours", false), makeTree("/repo/new-ours", true)] };
    await renderAndNodes(); // React Query's completed request triggers a new render.
    nodes = await renderAndNodes();
    assert.ok(nodes.some(node => textOf(node) === "Show all"));
    assert.ok(nodes.some(node => textOf(node).includes("/repo/new-ours")));
    assert.ok(!nodes.some(node => textOf(node).includes("/repo/not-ours")));
    const row = nodes.find(node => node.type === "Pressable" && textOf(node).includes("/repo/new-ours"));
    row.props.onPress();
    nodes = await renderAndNodes();
    nodes.find(node => node.type === "SettingsAction" && node.props.actionLabel === "Open").props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commands.at(-1).request.action, "worktree.open");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours", "actions target the visible path, not an unfiltered index");
  } finally { cleanup(); }
});
