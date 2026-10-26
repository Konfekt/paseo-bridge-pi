import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "../extension/bridge-transport.ts";
import { assertReadOnlyConversationResponse } from "../extension/read-only-session.ts";
import { callHarnessReadOnly } from "../plugin/server/harness-readonly-transport.ts";

test("reload replaces legacy64KiB readonly listener without replacing provider socket or losing500unicode messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-listener-upgrade-"));
  class LegacyTransport extends BridgeTransport {
    get harnessReadOnlySocketPath(): string { return `${this.pipePath}.harness-readonly`; }
  }
  const transport = new LegacyTransport("session", join(root, "bridge.sock"));
  delete (transport as any).readonlyEndpointVersion;
  let client: net.Socket | undefined, stalled: net.Socket | undefined;
  const result = { sessionId: "session", item: { messages: Array.from({ length: 500 }, (_, id) => ({ id: String(id), role: "assistant", text: "🌍".repeat(150) + "\u0000".repeat(40) })), liveText: "x".repeat(16 * 1024) } };
  const json = JSON.stringify(result);
  assert.ok(Buffer.byteLength(json) > 64 * 1024);
  assert.ok(Buffer.byteLength(json) > json.length, "UTF8 byte budget differs from character count");
  assertReadOnlyConversationResponse(result, "session");
  let currentResult: any = result;
  const callbacks = {
    command: async (cmd: any) => { transport.send({ id: cmd.id, owner: "same-provider" }); }, attached() {}, detached() {}, error() {},
    harnessReadOnly: async (request: any) => {
      if (request.runtimeEpoch !== transport.operatorEpoch || request.capability !== transport.harnessReadOnlyCapability || request.agentId !== "agent" || request.sessionId !== "session") throw new Error("Read-only harness authentication failed");
      return currentResult;
    },
  };
  const descriptor = () => ({ version: 1, socketPath: transport.harnessReadOnlySocketPath, capability: transport.harnessReadOnlyCapability, agentId: "agent", sessionId: "session", runtimeEpoch: transport.operatorEpoch });
  try {
    transport.bind(callbacks); transport.start();
    client = net.connect(transport.pipePath); await once(client, "connect");
    const readonly = (transport as any).readonlyServer as net.Server;
    await new Promise<void>(resolve => readonly.listening ? resolve() : readonly.once("listening", resolve));
    // Model the actual server closure retained from the old module: its wire
    // budget is fixed64KiB even though its callbacks/prototype have been updated.
    let legacyCalls = 0;
    readonly.removeAllListeners("connection");
    readonly.on("connection", socket => {
      (transport as any).readonlySockets.add(socket);
      socket.on("close", () => (transport as any).readonlySockets.delete(socket));
      let input = "";
      socket.on("data", chunk => {
        input += chunk.toString(); if (!input.endsWith("\n")) return;
        legacyCalls++;
        const request = JSON.parse(input);
        const response = { v: 1, type: "harness_readonly", id: request.id, success: false, error: "Oversized read-only result" };
        assert.ok(Buffer.byteLength(JSON.stringify(result)) > 64 * 1024);
        socket.end(JSON.stringify(response) + "\n");
      });
    });
    const stale = descriptor();
    await assert.rejects(callHarnessReadOnly(stale, "subagents.conversation", {}), /Oversized read-only result/);
    stalled = net.connect(stale.socketPath); await once(stalled, "connect");
    const stalledClosed = once(stalled, "close");
    retainBridgeForReload(transport, "agent", false);
    assert.equal(takeBridgeAfterReload("session")?.transport, transport);
    await stalledClosed;
    transport.bind(callbacks);
    assert.notEqual((transport as any).readonlyServer, readonly, "only legacy observation server replaced for Bun compatibility");
    assert.notEqual(descriptor().socketPath, stale.socketPath, "versioned endpoint cannot race legacy close/unlink");
    assert.equal(transport.connected, true);
    const page: any = await callHarnessReadOnly(descriptor(), "subagents.conversation", {});
    assert.deepEqual(page, result);
    assert.equal(page.item.messages.length, 500);
    assert.equal(legacyCalls, 1, "old module closure no longer handles requests");
    await assert.rejects(callHarnessReadOnly({ ...stale, socketPath: descriptor().socketPath }, "subagents.conversation", {}), /authentication failed/);
    await assert.rejects(callHarnessReadOnly(descriptor(), "jobs.output", {}), /Oversized read-only result/, "non-conversation limits remain64KiB");
    currentResult = { sessionId: "session", text: "x".repeat(768 * 1024) };
    await assert.rejects(callHarnessReadOnly(descriptor(), "subagents.conversation", {}), /Oversized read-only result/, "conversation wire budget remains bounded including envelope");
    const reply = once(client, "data"); client.write('{"id":123,"type":"get_state"}\n');
    assert.equal(JSON.parse((await reply)[0].toString()).owner, "same-provider");
    assert.equal(client.destroyed, false);
  } finally { discardRetainedBridge(); stalled?.destroy(); client?.destroy(); transport.close(); await rm(root, { recursive: true, force: true }); }
});
