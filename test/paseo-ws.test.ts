import assert from "node:assert/strict";
import test from "node:test";
import { createPaseoWsConnection, type PaseoSocket } from "../extension/paseo-ws.ts";

class Socket implements PaseoSocket {
  onopen: PaseoSocket["onopen"] = null;
  onclose: PaseoSocket["onclose"] = null;
  onerror: PaseoSocket["onerror"] = null;
  onmessage: PaseoSocket["onmessage"] = null;
  sent: any[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.onclose?.({}); }
  message(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  ack() { this.message({ type: "session", message: { type: "status", payload: { status: "server_info" } } }); }
  response(requestId: string, extra = {}) {
    this.message({ type: "session", message: { type: "response", payload: { requestId, ...extra } } });
  }
}
const hello = { type: "hello", clientId: "test", protocolVersion: 1 };
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function fixture(timeoutMs = 1000) {
  const socket = new Socket();
  return { socket, conn: createPaseoWsConnection(socket, hello, { timeoutMs }) };
}

test("session requests wait for actual server_info admission, not socket open", async () => {
  const { socket, conn } = fixture();
  const pending = conn.requestWithId("one", { type: "set_agent_model_request", requestId: "one" });
  await tick();
  assert.deepEqual(socket.sent, []);
  socket.onopen?.();
  socket.message({ type: "server_info" });
  socket.message({ type: "session", message: { type: "status", payload: { status: "other" } } });
  socket.response("one", { accepted: true }); // cannot satisfy a request before admission
  socket.onmessage?.({ data: "invalid JSON" });
  await tick();
  assert.deepEqual(socket.sent, [hello]);
  socket.ack();
  await tick();
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].message.requestId, "one");
  socket.response("one", { accepted: true });
  assert.deepEqual(await pending, { requestId: "one", accepted: true });
  conn.close();
});

test("correlates concurrent replies out of order, ignores unrelated frames", async () => {
  const { socket, conn } = fixture();
  socket.onopen?.(); socket.ack();
  let generatedId = "";
  const first = conn.request((requestId) => { generatedId = requestId; return { type: "first", requestId }; });
  const second = conn.requestWithId("second", { type: "second", requestId: "second" });
  await tick();
  socket.response("unrelated");
  socket.response("second", { accepted: false, error: "denied" });
  socket.response(generatedId, { accepted: true });
  assert.equal((await first).accepted, true);
  assert.equal((await second).error, "denied");
  conn.close();
});

test("hello timeout rejects waiting requests and closes without sending a session frame", async () => {
  const { socket, conn } = fixture(10);
  socket.onopen?.();
  await assert.rejects(conn.requestWithId("one", {}), /hello timeout/);
  assert.deepEqual(socket.sent, [hello]);
  assert.equal(socket.closed, true);
  socket.ack();
  await assert.rejects(conn.requestWithId("late", {}), /hello timeout/);
});

test("request timeout removes correlation and later requests still work", async () => {
  const { socket, conn } = fixture(10);
  socket.onopen?.(); socket.ack();
  await assert.rejects(conn.requestWithId("one", {}), /request timeout/);
  socket.response("one");
  const next = conn.requestWithId("two", {});
  await tick(); socket.response("two");
  assert.equal((await next).requestId, "two");
  conn.close();
});

for (const stage of ["before", "after"] as const) {
  for (const cause of ["close", "error", "local-close", "rejected"] as const) {
    test(`${cause} ${stage} admission rejects pending and future requests`, async () => {
      const { socket, conn } = fixture();
      socket.onopen?.();
      if (stage === "after") socket.ack();
      const pending = conn.requestWithId("one", {});
      const rejected = assert.rejects(pending, /connection|hello rejected/);
      await tick();
      if (cause === "close") socket.onclose?.({});
      if (cause === "error") socket.onerror?.({});
      if (cause === "local-close") conn.close();
      if (cause === "rejected") socket.message({ type: "hello.rejected" });
      await rejected;
      await assert.rejects(conn.requestWithId("later", {}), /connection|hello rejected/);
      assert.equal(socket.closed, true);
      assert.equal(socket.sent.length, stage === "before" ? 1 : 2);
    });
  }
}

test("synchronous send failure rejects every pending request", async () => {
  const { socket, conn } = fixture();
  socket.onopen?.(); socket.ack();
  const first = conn.requestWithId("one", {});
  const failedFirst = assert.rejects(first, /send failed/);
  await tick();
  socket.send = () => { throw new Error("send failed"); };
  await assert.rejects(conn.requestWithId("two", {}), /send failed/);
  await failedFirst;
  assert.equal(socket.closed, true);
});
