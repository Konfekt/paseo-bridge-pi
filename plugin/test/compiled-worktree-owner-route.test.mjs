import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(process.env.PASEO_PLUGIN_COMPILER, "PASEO_PLUGIN_COMPILER required");
test("compiled recorded-owner route reuses exact live runtime and rechecks source/child ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worktree-owner-route-"));
  try {
    await cp(join(root, "server"), join(dir, "server"), { recursive: true });
    await cp(join(root, "shared"), join(dir, "shared"), { recursive: true });
    await writeFile(join(dir, "index.server.ts"), 'export { createExistingChildRouteHandler } from "./server/existing-child-route"; export { resolveExactChildRuntime } from "./shared/existing-child-identity";');
    const { compilePlugin } = await import(pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER)));
    const { serverBundle } = await compilePlugin({ server: join(dir, "index.server.ts") });
    const { createExistingChildRouteHandler, resolveExactChildRuntime } = (0, eval)(serverBundle)(name => name === "@getpaseo/plugin" ? { defineRpc: x => x } : require(name));
    const identity = { taskId: `subagent-task-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, groupId: `subagent-job-${"c".repeat(24)}`, runtimeId: "runtime", attempt: 2 };
    const record = { ...identity, parentSessionId: "session", lifecycle: "active", managed: true, pid: 12345, processStartToken: "start-token", agentId: "exact-child", workspaceId: "exact-workspace" };
    assert.equal(resolveExactChildRuntime("session", identity, [record], () => "start-token").available, true);
    for (const [owner, rows, token] of [["other-session", [record], "start-token"], ["session", [record], "different-process"], ["session", [record, record], "start-token"], ["session", [{ ...record, lifecycle: "exited" }], "start-token"], ["session", [{ ...record, attempt: 1 }], "start-token"]]) {
      assert.equal(resolveExactChildRuntime(owner, identity, rows, () => token).available, false);
    }
    const descriptor = { version: 1, socketPath: "/tmp/unused-readonly", capability: "a".repeat(64), agentId: "parent", sessionId: "session", runtimeEpoch: randomUUID() };
    const input = { agentId: "parent", workspaceId: "parent-workspace", expectedSessionId: "session", expectedRuntimeEpoch: descriptor.runtimeEpoch, ...identity };
    const route = { available: true, agentId: "exact-child", workspaceId: "exact-workspace", reason: null };
    const setup = (scenario = "success") => {
      let reads = 0, resolutions = 0;
      const handler = createExistingChildRouteHandler({
        readDescriptor: async () => ({ ...descriptor, ...(scenario === "source-changed" && ++reads > 1 ? { runtimeEpoch: randomUUID() } : {}) }),
        resolve: async () => ({ ...route, ...(scenario === "missing" ? { available: false, reason: "No matching live child" } : scenario === "route-changed" && ++resolutions > 1 ? { agentId: "unrelated-child" } : {}) }),
      });
      const context = { paseo: { agents: { ref: id => ({ refresh: async () => ({ agent: id === "parent" ? { id, workspaceId: "parent-workspace", provider: "pi" } : { id, workspaceId: scenario === "foreign-workspace" ? "foreign" : "exact-workspace", provider: "pi", ...(scenario === "archived" ? { archivedAt: 1 } : {}) } }) }) } } };
      return () => handler(input, context);
    };
    assert.deepEqual(await setup()(), { agentId: "exact-child", workspaceId: "exact-workspace" });
    for (const scenario of ["missing", "source-changed", "foreign-workspace", "archived", "route-changed"]) await assert.rejects(setup(scenario)(), undefined, scenario);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
