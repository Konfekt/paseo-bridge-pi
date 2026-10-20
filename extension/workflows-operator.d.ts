import type { BtwIdentity } from "./btw-operator.js";
export function workflowsSocketPath(pipe: string): string;
export function writeWorkflowsDescriptor(
	base: string,
	descriptor: BtwIdentity & { version: 1; socketPath: string },
): string;
export function removeWorkflowsDescriptor(
	base: string,
	agentId: string,
	epoch: string,
): void;
