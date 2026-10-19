export function accountControlsSocketPath(bridgeSocket: string): string;
export function accountControlsDescriptorPath(baseDir: string, agentId: string): string;
export function writeAccountControlsDescriptor(baseDir: string, descriptor: any): string;
export function removeAccountControlsDescriptor(baseDir: string, agentId: string, runtimeEpoch: string): void;
export function validateAccountControlsEnvelope(value: unknown, identity: any): boolean;
export function accountControlsCapability(): string;
