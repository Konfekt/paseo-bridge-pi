import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const independentAgentOpenRpc = defineRpc({ name: "independent_agent_open", input: z.object({
  agentId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256),
  expectedSessionId: z.string().min(1).max(256), expectedRuntimeEpoch: z.string().uuid(),
  taskId: z.string().regex(/^subagent-task-[a-f0-9]{24}$/), childId: z.string().regex(/^subagent-child-[a-f0-9]{24}$/),
  attempt: z.number().int().min(1), runtimeId: z.string().max(256).nullable(),
}), output: z.object({ agentId: z.string().min(1).max(128) }) });
