import * as path from "node:path";
import {
	writeAccountControlsDescriptor,
	removeAccountControlsDescriptor,
} from "./account-controls-operator.js";
export const workflowsSocketPath = (pipe) => `${pipe}.workflows`;
export const writeWorkflowsDescriptor = (base, descriptor) =>
	writeAccountControlsDescriptor(path.join(base, "workflows"), descriptor);
export const removeWorkflowsDescriptor = (base, agentId, epoch) =>
	removeAccountControlsDescriptor(path.join(base, "workflows"), agentId, epoch);
