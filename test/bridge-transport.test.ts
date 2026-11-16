import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "../extension/bridge-transport.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-reload-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${root.replace(/[^a-z0-9]/gi, "")}` : join(root, "bridge.sock");
  const transport = new BridgeTransport("same-session", socketPath);
  const errors: unknown[] = [];
  let oldCalls = 0;
  transport.bind({ command: async (cmd) => { oldCalls++; transport.send({ id: cmd.id, owner: "old" }); }, attached() {}, detached() {}, error: error => errors.push(error) });
  transport.start();
  const client = net.connect(socketPath);
  const messages: any[] = [];
  let buffer = "";
  client.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  await once(client, "connect");
  async function response(id: number) {
    const deadline = Date.now() + 2000;
    while (!messages.some(message => message.id === id)) {
      assert(Date.now() < deadline, `missing response ${id}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return messages.find(message => message.id === id);
  }
  return { root, socketPath, transport, client, errors, response, oldCalls: () => oldCalls, async close() {
    discardRetainedBridge();
    client.destroy();
    transport.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test("same-session reload retains the socket and routes subsequent commands only to the new context", async () => {
  const f = await fixture();
  try {
    f.client.write('{"id":1,"type":"get_state"}\n');
    assert.equal((await f.response(1)).owner, "old");
    const previousConnectionEpoch = f.transport.connectionEpoch;
    assert.equal(typeof previousConnectionEpoch, "string");
    retainBridgeForReload(f.transport, "existing-agent");
    f.client.write('{"id":2,"type":"prompt","message":"do not dispatch during reload"}\n');
    assert.equal((await f.response(2)).success, false);
    assert.equal(f.oldCalls(), 1);
    const retained = takeBridgeAfterReload("same-session");
    assert.equal(retained?.transport, f.transport);
    assert.equal(retained?.agentId, "existing-agent");
    f.transport.bind({ command: async cmd => { f.transport.send({ id: cmd.id, owner: "new", text: cmd.message }); }, attached() {}, detached() {}, error: error => f.errors.push(error) });
    assert.notEqual(f.transport.connectionEpoch, previousConnectionEpoch, "reload invalidates replies admitted by the old context");
    const frame = Buffer.from('{"id":3,"type":"prompt","message":"🌍"}\n');
    const offset = frame.indexOf(Buffer.from("🌍"));
    f.client.write(frame.subarray(0, offset + 1));
    await new Promise(resolve => setTimeout(resolve, 5));
    f.client.write(frame.subarray(offset + 1));
    assert.deepEqual(await f.response(3), { id: 3, owner: "new", text: "🌍" });
    assert.equal(f.oldCalls(), 1);
    assert.equal(f.client.destroyed, false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a controller can reconnect to the same endpoint if it disconnects during reload", async () => {
  const f = await fixture();
  let replacement: net.Socket | undefined;
  try {
    retainBridgeForReload(f.transport, "existing-agent");
    f.client.destroy();
    const deadline = Date.now() + 2000;
    while (f.transport.connected) {
      assert(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(takeBridgeAfterReload("same-session")?.agentId, "existing-agent");
    f.transport.bind({ command: async cmd => { f.transport.send({ id: cmd.id, owner: "replacement" }); }, attached() {}, detached() {}, error: error => f.errors.push(error) });
    replacement = net.connect(f.socketPath);
    await once(replacement, "connect");
    const reply = once(replacement, "data");
    replacement.write('{"id":5,"type":"get_state"}\n');
    const [data] = await reply;
    assert.equal(JSON.parse(data.toString()).owner, "replacement");
    assert.deepEqual(f.errors, []);
  } finally { replacement?.destroy(); await f.close(); }
});

test("session replacement closes a retained bridge instead of adopting the wrong session", async () => {
  const f = await fixture();
  try {
    const closed = once(f.client, "close");
    retainBridgeForReload(f.transport, null);
    assert.equal(takeBridgeAfterReload("different-session"), undefined);
    await closed;
    assert.equal(f.transport.connected, false);
  } finally { await f.close(); }
});

test("a failed or removed extension cannot retain a suspended socket forever", async () => {
  const f = await fixture();
  try {
    const closed = once(f.client, "close");
    retainBridgeForReload(f.transport, null, 20);
    await closed;
    assert.equal(takeBridgeAfterReload("same-session"), undefined);
  } finally { await f.close(); }
});

test("a second controller is rejected without disrupting the retained controller", async () => {
  const f = await fixture();
  try {
    const other = net.connect(f.socketPath);
    const [data] = await once(other, "data");
    assert.match(data.toString(), /another controller/);
    other.destroy();
    f.client.write('{"id":4,"type":"get_state"}\n');
    assert.equal((await f.response(4)).owner, "old");
    assert.equal(f.client.destroyed, false);
  } finally { await f.close(); }
});

test("oversized controller frames disconnect without dispatching a command", async () => {
  const f = await fixture();
  f.client.on("error", () => {});
  try {
    const closed = new Promise<boolean>(resolve => f.client.once("close", () => resolve(true)));
    f.client.write("x".repeat(16 * 1024 * 1024 + 1));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await Promise.race([closed, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]), true, "oversized frame must close promptly");
    } finally { clearTimeout(timer); }
    assert.equal(f.oldCalls(), 0);
    assert.match(String(f.errors[0]), /frame.*limit/i);
  } finally { await f.close(); }
});

test("oversized outgoing frames close the controller instead of retaining an unbounded write", async () => {
  const f = await fixture();
  f.client.on("error", () => {});
  try {
    const closed = new Promise<void>(resolve => f.client.once("close", () => resolve()));
    f.transport.send({ text: "x".repeat(16 * 1024 * 1024) });
    assert.equal(f.transport.connected, false);
    await closed;
    assert.match(String(f.errors[0]), /frame.*limit/i);
  } finally { await f.close(); }
});

test("a stalled controller cannot retain more than the bounded output queue", async () => {
  const f = await fixture();
  f.client.on("error", () => {});
  try {
    f.client.pause();
    const frame = { text: "x".repeat(8 * 1024 * 1024) };
    for (let index = 0; index < 6 && f.transport.connected; index++) f.transport.send(frame);
    assert.equal(f.transport.connected, false);
    assert.match(String(f.errors[0]), /write queue.*limit/i);
  } finally { await f.close(); }
});

test("cleanup is best effort when the socket file cannot be removed", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-cleanup-"));
  const directory = join(root, "run");
  await mkdir(directory);
  const errors: unknown[] = [];
  const callbacks = { command: async () => {}, attached() {}, detached() {}, error: (error: unknown) => errors.push(error) };
  const transports = [new BridgeTransport("direct", join(directory, "a.sock")), new BridgeTransport("retained", join(directory, "b.sock"))];
  try {
    for (const transport of transports) {
      transport.bind(callbacks);
      transport.start();
    }
    const deadline = Date.now() + 2000;
    for (const transport of transports) {
      for (;;) {
        try { await access(transport.pipePath); break; }
        catch { assert(Date.now() < deadline, "bridge socket must be created"); await new Promise(resolve => setTimeout(resolve, 5)); }
      }
    }
    await chmod(directory, 0o500);
    // A direct teardown (disconnect, session switch) must not throw midway.
    assert.doesNotThrow(() => transports[0].close());
    // An abandoned reload is released from a timer, where a throw would crash Pi.
    retainBridgeForReload(transports[1], null, 5);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(takeBridgeAfterReload("retained"), undefined);
    assert.equal(errors.length, 2, "each cleanup failure is still reported");
  } finally {
    await chmod(directory, 0o700);
    for (const transport of transports) transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("frames split inside a UTF-8 character or ending in CRLF are decoded intact", async () => {
  const f = await fixture();
  try {
    f.transport.bind({ command: async cmd => { f.transport.send({ id: cmd.id, owner: "new", text: cmd.message }); }, attached() {}, detached() {}, error: error => f.errors.push(error) });
    const frame = Buffer.from('{"id":7,"type":"prompt","message":"caf\u00e9 \u2713"}\r\n{"id":8,"type":"prompt","message":"x"}\n', "utf8");
    const split = frame.indexOf(Buffer.from("\u00e9", "utf8")) + 1;
    f.client.write(frame.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 20));
    f.client.write(frame.subarray(split));
    assert.equal((await f.response(7)).text, "caf\u00e9 \u2713");
    assert.equal((await f.response(8)).text, "x");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
