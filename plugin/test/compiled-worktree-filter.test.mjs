import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, "PASEO_PLUGIN_COMPILER is required; Worktree tests must execute");
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("compiled Worktrees: explicit scope, branch identity, independent path links and unchanged removal gates", async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, "index.client.tsx") });
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const colors = { foreground: "#fff", foregroundMuted: "#aaa", statusDanger: "#f00", surface0: "#111", surface1: "#222", surface2: "#333", border: "#444", accent: "#0af", statusWarning: "#fa0", statusSuccess: "#0f0", accentForeground: "#000" };
  let sessionId = "session-a", snapshot, queryPromise, hookIndex = 0;
  const commands = [], hookStates = [], opened = [];
  const data = () => ({ available: true, enabled: true, sessionId, runtimeEpoch: "runtime", snapshot: { ...snapshot, serviceEpoch: "service" } });
  const load = name => {
    if (name === "@getpaseo/plugin") return { defineRpc: x => x, defineSettings: x => x };
    if (name === "zod") { const schema = new Proxy({}, { get: () => () => schema }); return { z: new Proxy({}, { get: () => () => schema }) }; }
    if (name === "@getpaseo/plugin/client/ui") return { SettingsCard: "SettingsCard", SettingsSection: "SettingsSection", SettingsSelect: "SettingsSelect", SettingsAction: "SettingsAction" };
    if (name === "@getpaseo/plugin/client") return { useRpc: contract => contract.name === "workflows_status" ? async () => data() : async value => { commands.push(value); return { accepted: true, openedWorkspaceId: "exact-workspace", snapshot }; } };
    if (name === "@getpaseo/plugin/client/react-native") return { ScrollView: "ScrollView", TextInput: "TextInput" };
    if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable" };
    if (name === "react") return { useEffect() {}, useRef: initial => ({ current: initial }), useState: initial => { const i = hookIndex++; hookStates[i] ??= typeof initial === "function" ? initial() : initial; return [hookStates[i], next => { hookStates[i] = typeof next === "function" ? next(hookStates[i]) : next; }]; } };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@tanstack/react-query") return { useQuery: options => { queryPromise ??= options.queryFn(); return { data: data(), isError: false, isFetching: false, refetch: async () => {} }; }, useMutation: () => ({ mutate() {} }) };
    return require(name);
  };
  let worktrees;
  const cleanup = (0, eval)(clientBundle)(load).default({
    paseo: { config: { get: async () => ({ config: {} }) }, agents: { list: async () => ({ subscription: { subscribe() {} } }) } },
    rpc: async () => ({}), addWorkspacePanel: value => { if (value.id === "pi-worktrees") worktrees = value; return () => {}; }, addScreen: () => () => {}, addComposerPill: () => ({ update() {}, remove() {} }),
  });
  const textOf = n => typeof n === "string" ? n : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" ? textOf(n.props?.children) : "";
  async function render() {
    hookIndex = 0;
    const tree = worktrees.Component({ host: { id: "host" }, agentId: "agent", workspaceId: "workspace", theme: { colors }, layout: { platform: "web", compact: false }, navigation: { openWorkspace: input => opened.push(input) } });
    await queryPromise; queryPromise = undefined;
    const nodes = [];
    const visit = n => { if (!n || typeof n !== "object") return; nodes.push(n); for (const c of [n.props?.children].flat(Infinity)) visit(c); };
    visit(tree); return nodes;
  }
  const press = (nodes, label) => nodes.find(n => n.type === "Pressable" && textOf(n) === label);
  const row = nodes => nodes.find(n => n.type === "Pressable" && n.props.accessibilityState?.expanded !== undefined);
  const link = nodes => nodes.find(n => n.props?.accessibilityRole === "link");
  const makeTree = (path, createdInSession, repositoryPath = "/repo", extra = {}) => ({ path, createdInSession, repositoryPath, repositoryLabel: repositoryPath, branch: "pi/branch", head: "abcdef", main: false, current: false, locked: false, stale: false, detached: false, changedFiles: 0, ...extra });
  const idle = { protocol: 1, sessionId, serviceEpoch: "service", cwd: "/repo", model: null, busy: false, idle: true, notice: null, operationId: null, operationAction: null, protectedPaths: [], dialog: null, worktreeError: null, worktreeLoading: false, worktreeRepositoryCount: 1, worktreeContainer: false, goal: null, completedGoals: [], lastCompletion: null, worktree: null, worktrees: [] };
  try {
    snapshot = { ...idle, worktrees: [makeTree("/repo/other", false), makeTree("/second/ours", true, "/second"), makeTree("/second/also-ours", true, "/second"), makeTree("/repo/ours", true)] };
    let nodes = await render();
    press(nodes, "Connect current session")?.props.onPress();
    nodes = await render();
    assert.ok(!nodes.some(n => textOf(n).includes("/repo/other")));
    assert.deepEqual(nodes.filter(n => n.props?.accessibilityRole === "header").map(textOf), ["/second", "/repo"]);
    assert.equal(press(nodes, "This session").props.accessibilityState.selected, true);
    snapshot.worktreeError = "Permission denied [synthetic]";
    nodes = await render();
    assert.ok(nodes.some(n => textOf(n) === snapshot.worktreeError));
    press(nodes, "All worktrees").props.onPress(); nodes = await render();
    assert.ok(nodes.some(n => textOf(n).includes("/repo/other")));
    press(nodes, "This session").props.onPress(); nodes = await render();
    assert.ok(!nodes.some(n => textOf(n).includes("/repo/other")));
    snapshot = { ...idle, worktrees: [makeTree("/repo/legacy", undefined)] };
    nodes = await render(); assert.ok(nodes.some(n => textOf(n) === "No session-created worktrees"));
    press(nodes, "All worktrees").props.onPress(); nodes = await render(); assert.ok(link(nodes));
    sessionId = "session-b"; snapshot = { ...idle, sessionId, worktrees: [makeTree("/repo/not-ours", false), makeTree("/repo/new-ours", true, "/repo", { ownerTitle: "RAW TASK INSTRUCTIONS DO NOT DISPLAY" })] };
    await render(); nodes = await render();
    assert.equal(press(nodes, "This session").props.accessibilityState.selected, true);
    assert.equal(textOf(row(nodes)), "▸ pi/branch");
    assert.ok(!nodes.some(n => textOf(n).includes("RAW TASK")));
    assert.equal(row(nodes).props.accessibilityState.expanded, false);
    link(nodes).props.onPress(); await new Promise(r => setImmediate(r)); nodes = await render();
    assert.equal(row(nodes).props.accessibilityState.expanded, false, "path action is a sibling, not an expansion target");
    assert.equal(commands.at(-1).request.action, "worktree.open");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours");
    assert.deepEqual(opened.at(-1), { workspaceId: "exact-workspace", serverId: "host" });
    let prevented = 0, stopped = 0;
    link(nodes).props.onKeyDown({ key: "Enter", preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    await new Promise(r => setImmediate(r)); nodes = await render();
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(row(nodes).props.accessibilityState.expanded, false, "keyboard directory activation must not expand");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours");
    snapshot.worktrees[1].diffStat = { additions: 128, deletions: 34 };
    nodes = await render();
    const workspaceAction = nodes.find(n => n.type === "Pressable" && n.props.accessibilityLabel === "Open worktree workspace /repo/new-ours; then select native Changes");
    assert.equal(textOf(workspaceAction), "+128−34");
    workspaceAction.props.onPress(); await new Promise(r => setImmediate(r)); nodes = await render();
    assert.equal(row(nodes).props.accessibilityState.expanded, false, "stats action is independent of expansion");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours");
    assert.deepEqual(opened.at(-1), { workspaceId: "exact-workspace", serverId: "host" });
    snapshot.worktrees[1].diffStat = null; nodes = await render();
    assert.equal(textOf(nodes.find(n => n.type === "Pressable" && n.props.accessibilityLabel === workspaceAction.props.accessibilityLabel)), "Open ↗", "unavailable stats aren't invented from changedFiles");
    row(nodes).props.onPress(); nodes = await render();
    assert.equal(row(nodes).props.accessibilityState.expanded, true);
    assert.ok(!nodes.some(n => n.props?.label === "Open workspace"));
    assert.equal(nodes.filter(n => n.type === "Text" && textOf(n).includes("/repo/new-ours")).length, 1);
    assert.ok(nodes.some(n => textOf(n) === "Working copy clean"));
    assert.equal(press(nodes, "Remove…").props.disabled, false);
    for (const extra of [{ inUse: true }, { current: true }, { main: true }, { locked: true }, { stale: true }, { changedFiles: null }, { changedFiles: 2 }]) {
      snapshot.worktrees = [makeTree("/repo/new-ours", true, "/repo", extra)]; nodes = await render();
      assert.equal(press(nodes, "Remove…").props.disabled, true, JSON.stringify(extra));
    }
    for (const extra of [{ busy: true }, { idle: false }, { goal: { id: "goal", status: "active", title: "Goal", tasks: [] } }]) {
      snapshot = { ...idle, ...extra, sessionId, worktrees: [makeTree("/repo/new-ours", true)] }; nodes = await render();
      assert.equal(press(nodes, "Remove…").props.disabled, true, JSON.stringify(extra));
    }
    for (const [extra, title] of [[{ branch: null, detached: true }, "Detached HEAD"], [{ branch: null, detached: false }, "Branch unavailable"]]) {
      snapshot = { ...idle, sessionId, worktrees: [makeTree("/repo/new-ours", true, "/repo", extra)] }; nodes = await render();
      assert.equal(textOf(row(nodes)), `▾ ${title}`);
    }
    assert.equal(commands.filter(c => c.request.action === "worktree.remove").length, 0, "no destructive action executed by tests");
  } finally { cleanup(); }
});
