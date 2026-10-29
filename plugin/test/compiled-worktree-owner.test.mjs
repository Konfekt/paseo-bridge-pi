import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, "PASEO_PLUGIN_COMPILER required");
const require = createRequire(resolve(compiler));

test("compiled Agent copy hides unavailable chat but preserves exact route checks and accessible failures", async t => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
  const fixture = await mkdtemp(resolve(tmpdir(), "worktree-owner-ui-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ["client", "shared"]) await cp(fileURLToPath(new URL(`../${directory}`, import.meta.url)), resolve(fixture, directory), { recursive: true });
  await writeFile(resolve(fixture, "index.client.tsx"), 'export { WorktreeOwner } from "./client/worktree-owner";');
  const { clientBundle } = await compilePlugin({ client: resolve(fixture, "index.client.tsx") });
  const owner = { ownerSessionId: "session", taskId: `subagent-task-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, canonicalDisplayName: "Bridge Worker" };
  const item = { ...owner, groupId: `subagent-job-${"c".repeat(24)}`, runtimeId: "runtime", attempt: 2, stale: false, status: "completed", paseoAgentId: "child-agent", paseoWorkspaceId: "child-workspace" };
  let bound, inventory, query, options, slots = [], cursor = 0, rejectRoute = false, resolveRoute;
  const opened = [], calls = [];
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const load = name => {
    if (name === "@getpaseo/plugin") return { defineRpc: x => x };
    if (name === "@getpaseo/plugin/client") return { useAgent: () => null, useRpc: contract => async input => {
      if (contract.name === "harness_status") return bound;
      if (contract.name === "harness_subagents_list") return inventory;
      calls.push(input);
      if (rejectRoute) throw new Error("changed runtime");
      if (resolveRoute) return new Promise(resolveRoute);
      return { agentId: "verified-child", workspaceId: "child-workspace" };
    } };
    if (name === "@tanstack/react-query") return { useQuery: value => { options = value; return query; } };
    if (name === "react") return { useEffect() {}, useRef: initial => ({ current: initial }), useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; } };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable" };
    if (name === "@getpaseo/plugin/client/ui") return { SettingsAction: "SettingsAction" };
    if (name === "@getpaseo/plugin/client/react-native") return {};
    return require(name);
  };
  const { WorktreeOwner } = (0, eval)(clientBundle)(load);
  const props = { owner, sessionId: "session", runtimeEpoch: "epoch", host: { id: "host" }, agentId: "parent", workspaceId: "workspace", theme: { colors: {} }, layout: { platform: "web" }, onOpenAgent: id => opened.push(id) };
  const nodes = n => !n || typeof n !== "object" ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];
  const draw = (extra = {}) => { cursor = 0; return nodes(WorktreeOwner({ ...props, ...extra })); };
  const button = all => all.find(n => n.type === "Pressable");
  const settle = () => new Promise(r => setImmediate(r));
  async function setup(extra = {}) {
    slots = []; bound = { available: true, sessionId: "session", runtimeEpoch: "epoch" };
    inventory = { state: "available", sessionId: "session", stale: false, hierarchyPartial: false, items: [item], ...extra };
    query = { isError: false, isFetching: false }; draw(); query.data = await options.queryFn();
  }
  await setup();
  let all = draw();
  assert.ok(all.some(n => n.type === "Text" && n.props.children === "Agent"));
  assert.equal(button(all).props.accessibilityLabel, "Open chat");
  button(all).props.onPress(); await settle();
  assert.deepEqual(opened, ["verified-child"]);
  assert.deepEqual(calls[0], { agentId: "parent", workspaceId: "workspace", expectedSessionId: "session", expectedRuntimeEpoch: "epoch", taskId: item.taskId, childId: item.childId, groupId: item.groupId, runtimeId: "runtime", attempt: 2 });
  for (const extra of [{ items: [] }, { hierarchyPartial: true }, { stale: true }, { items: [{ ...item, reaped: true }] }, { items: [{ ...item, stale: true }] }, { items: [{ ...item, paseoAgentId: undefined }] }, { items: [item, item] }]) {
    await setup(extra); all = draw();
    assert.equal(button(all), undefined, JSON.stringify(extra));
    assert.ok(!all.some(n => n.type === "Text" && /Recorded owner|No verified|unavailable|inventory|Verifying/.test(String(n.props.children))), "routine unavailable state has no backend diagnostics");
    assert.ok(all.some(n => n.props.accessibilityLabel === "Agent status unknown"));
  }
  await setup(); bound.runtimeEpoch = "changed"; query.data = await options.queryFn(); assert.equal(button(draw()), undefined);
  await setup(); assert.equal(button(draw({ onOpenAgent: undefined })), undefined);
  for (const state of [{ isError: true }, { isFetching: true }]) { await setup(); Object.assign(query, state); assert.equal(button(draw()), undefined); }
  await setup(); rejectRoute = true; button(draw()).props.onPress(); await settle(); all = draw();
  assert.equal(button(all), undefined);
  assert.ok(all.some(n => n.props.accessibilityRole === "alert" && n.props.children === "Chat unavailable. Refresh to retry."));
  assert.deepEqual(opened, ["verified-child"], "failed validation never navigates");
  rejectRoute = false; await setup();
  let finish; resolveRoute = resolve => { finish = resolve; };
  button(draw()).props.onPress(); await settle();
  assert.equal(button(draw()).props.disabled, true, "in-flight verified chat cannot be opened twice");
  finish({ agentId: "verified-child" }); await settle();
});
