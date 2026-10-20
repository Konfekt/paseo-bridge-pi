export type BtwIdentity = {
	agentId: string;
	sessionId: string;
	runtimeEpoch: string;
	serviceEpoch: string;
	capability: string;
};
export function btwSocketPath(pipePath: string): string;
export function btwDescriptorPath(baseDir: string, agentId: string): string;
export function writeBtwDescriptor(
	baseDir: string,
	descriptor: BtwIdentity & { version: 1; socketPath: string },
): string;
export function removeBtwDescriptor(
	baseDir: string,
	agentId: string,
	runtimeEpoch: string,
): void;
export function validateBtwEnvelope(
	value: unknown,
	identity: BtwIdentity,
	wireType?: string,
): boolean;
export function createBtwEndpoint(
	pipePath: string,
	callbacks: () =>
		| {
				btwIdentity?(): BtwIdentity | undefined;
				btw?(request: unknown): Promise<unknown>;
				error?(error: unknown): void;
		  }
		| undefined,
	wireType?: string,
	suffix?: string,
): { close(): void };
