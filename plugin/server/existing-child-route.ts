import { resolveExactChildRuntime } from "../shared/existing-child-identity";
import { readHarnessDescriptor } from "./harness-readonly";
import { validateHarnessReadOnlyDescriptor } from "./harness-readonly-transport";
import { readPrivateChildRuntimes, processStartToken } from "./child-runtime-registry";
export { readPrivateChildRuntimes } from "./child-runtime-registry";

export function createExistingChildRouteHandler(deps = {
  readDescriptor: readHarnessDescriptor,
  resolve: async (sessionId: string, input: any) => resolveExactChildRuntime(sessionId, input, await readPrivateChildRuntimes(), processStartToken),
}) {
  return async (input: any, context: any) => {
    const assertParent = async () => {
      const parent = await context.paseo.agents.ref(input.agentId).refresh();
      if (parent?.agent.id !== input.agentId || parent.agent.workspaceId !== input.workspaceId) throw new Error("The source agent workspace changed.");
      const descriptor = await deps.readDescriptor(input.agentId);
      if (!validateHarnessReadOnlyDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch) throw new Error("The source session changed; reopen its Agents list.");
      return descriptor;
    };
    const pinned = await assertParent();
    const route = await deps.resolve(input.expectedSessionId, input);
    if (!route.available || !route.agentId || !route.workspaceId) throw new Error(route.reason ?? "No existing live child conversation is registered.");
    const child = await context.paseo.agents.ref(route.agentId).refresh();
    if (child?.agent.id !== route.agentId || child.agent.workspaceId !== route.workspaceId || child.agent.provider !== "pi" || child.agent.archivedAt) throw new Error("The registered child conversation is no longer available.");
    const current = await assertParent();
    const checked = await deps.resolve(input.expectedSessionId, input);
    if (current.capability !== pinned.capability || current.socketPath !== pinned.socketPath || !checked.available || checked.agentId !== route.agentId || checked.workspaceId !== route.workspaceId) throw new Error("Child conversation ownership changed while resolving its route.");
    return { agentId: route.agentId, workspaceId: route.workspaceId };
  };
}
