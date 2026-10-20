import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
	readAccountControlsDescriptor,
	validateAccountControlsDescriptor,
	type AccountControlsDescriptor,
} from "./account-controls-transport.ts";
export type BtwDescriptor = AccountControlsDescriptor;
export const validateBtwDescriptor = validateAccountControlsDescriptor;
export function readBtwDescriptor(
	agentId: string,
	baseDir = join(homedir(), ".pi", "paseo-bridge"),
) {
	return readAccountControlsDescriptor(agentId, join(baseDir, "btw"));
}
export function callBtw(
	d: BtwDescriptor,
	request: Record<string, unknown>,
	timeoutMs = 5000,
	wireType = "btw",
): Promise<unknown> {
	const id = randomUUID(),
		frame = `${JSON.stringify({
			v: 1,
			type: wireType,
			id,
			capability: d.capability,
			agentId: d.agentId,
			sessionId: d.sessionId,
			runtimeEpoch: d.runtimeEpoch,
			serviceEpoch: d.serviceEpoch,
			request,
		})}\n`;
	if (Buffer.byteLength(frame) > 64 * 1024)
		throw new Error("Oversized BTW request");
	return new Promise((resolve, reject) => {
		let socket: ReturnType<typeof connect> | undefined,
			settled = false,
			buffer = "";
		const decoder = new StringDecoder("utf8");
		const timer = setTimeout(
			() => finish(new Error("BTW request timed out")),
			timeoutMs,
		);
		function finish(error?: Error, value?: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			error ? reject(error) : resolve(value);
		}
		void (async () => {
			try {
				const stat = await lstat(d.socketPath);
				if (settled) return;
				if (
					!stat.isSocket() ||
					(typeof process.getuid === "function" &&
						stat.uid !== process.getuid()) ||
					(stat.mode & 0o777) !== 0o600
				)
					throw new Error("BTW socket is not private");
				socket = connect(d.socketPath);
				socket.once("error", (error) => finish(error));
				socket.once("connect", () => {
					if (!settled) socket!.write(frame);
				});
				socket.on("data", (chunk) => {
					buffer += decoder.write(chunk);
					if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
						finish(new Error("Oversized BTW response"));
						return;
					}
					const nl = buffer.indexOf("\n");
					if (nl < 0) return;
					try {
						if (nl !== buffer.length - 1)
							throw new Error("Invalid BTW framing");
						const result = JSON.parse(buffer.slice(0, nl));
						if (
							result?.v !== 1 ||
							result.type !== wireType ||
							result.id !== id ||
							typeof result.success !== "boolean"
						)
							throw new Error("Invalid BTW response");
						if (!result.success)
							throw new Error(
								"BTW request failed; refresh status before retrying",
							);
						if (
							result.agentId !== d.agentId ||
							result.sessionId !== d.sessionId ||
							result.runtimeEpoch !== d.runtimeEpoch ||
							result.serviceEpoch !== d.serviceEpoch
						)
							throw new Error("BTW identity mismatch");
						finish(undefined, result.data);
					} catch (error) {
						finish(
							error instanceof Error
								? error
								: new Error("Invalid BTW response"),
						);
					}
				});
				socket.once("end", () =>
					finish(new Error("BTW socket closed without a response")),
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error("BTW unavailable"));
			}
		})();
	});
}
