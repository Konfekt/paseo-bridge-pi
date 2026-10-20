import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
	createBtwEndpoint,
	btwSocketPath,
	writeBtwDescriptor,
	removeBtwDescriptor,
	validateBtwEnvelope,
} from "../../extension/btw-operator.js";
import {
	callBtw,
	readBtwDescriptor,
	validateBtwDescriptor,
} from "../server/btw-transport.ts";

test("BTW private socket binds capability/session/runtime/service and rejects replay after replacement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "btw-")),
		pipe = join(dir, "bridge");
	const identity = {
		agentId: "agent",
		sessionId: "session",
		runtimeEpoch: randomUUID(),
		serviceEpoch: randomUUID(),
		capability: "a".repeat(64),
	};
	let active = identity,
		calls = 0;
	const endpoint = createBtwEndpoint(pipe, () => ({
		btwIdentity: () => active,
		btw: async (request) => {
			calls++;
			return { operation: (request as any).operation };
		},
	}));
	try {
		// Socket existence is established by a successful connection, not a timing sleep.
		const probe = connect(btwSocketPath(pipe));
		await once(probe, "connect");
		probe.destroy();
		const descriptor = {
			version: 1 as const,
			socketPath: btwSocketPath(pipe),
			...identity,
		};
		writeBtwDescriptor(dir, descriptor);
		assert.deepEqual(await readBtwDescriptor("agent", dir), descriptor);
		assert.equal(validateBtwDescriptor(descriptor, "other"), false);
		assert.equal((await stat(descriptor.socketPath)).mode & 0o777, 0o600);
		const request = {
			operation: "snapshot",
			sessionId: identity.sessionId,
			serviceEpoch: identity.serviceEpoch,
		};
		assert.deepEqual(await callBtw(descriptor, request), {
			operation: "snapshot",
		});
		assert.equal(calls, 1);
		await assert.rejects(
			callBtw({ ...descriptor, capability: "b".repeat(64) }, request),
		);
		assert.equal(calls, 1);
		await assert.rejects(
			callBtw(descriptor, { ...request, sessionId: "wrong" }),
		);
		assert.equal(calls, 1);
		active = { ...identity, runtimeEpoch: randomUUID() };
		await assert.rejects(callBtw(descriptor, request));
		assert.equal(calls, 1);
		removeBtwDescriptor(dir, "agent", randomUUID());
		assert.ok(await readBtwDescriptor("agent", dir));
		removeBtwDescriptor(dir, "agent", identity.runtimeEpoch);
		assert.equal(await readBtwDescriptor("agent", dir), undefined);
	} finally {
		endpoint.close();
		await rm(dir, { recursive: true, force: true });
	}
});
test("BTW envelope is strict and does not reuse account-control operations", () => {
	const identity = {
		agentId: "agent",
		sessionId: "session",
		runtimeEpoch: randomUUID(),
		serviceEpoch: randomUUID(),
		capability: "a".repeat(64),
	};
	const frame = {
		v: 1,
		type: "btw",
		id: randomUUID(),
		...identity,
		request: {
			operation: "snapshot",
			sessionId: identity.sessionId,
			serviceEpoch: identity.serviceEpoch,
		},
	};
	assert.equal(validateBtwEnvelope(frame, identity), true);
	for (const bad of [
		{ ...frame, extra: true },
		{ ...frame, type: "account_controls" },
		{ ...frame, request: { ...frame.request, operation: "switch" } },
		{ ...frame, serviceEpoch: randomUUID() },
	])
		assert.equal(validateBtwEnvelope(bad, identity), false);
});
