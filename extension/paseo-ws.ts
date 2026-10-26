import { randomUUID } from "node:crypto";

export interface PaseoSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Paseo admits hello asynchronously. Socket open (and even sending hello)
 * does not permit session requests; status.server_info acknowledges admission. */
export function createPaseoWsConnection(
  ws: PaseoSocket,
  hello: Record<string, unknown>,
  { timeoutMs = 5000, log = (_message: string) => {}, onSession = (_message: any) => {}, onFailure = (_error: Error) => {} } = {},
) {
  let failure: Error | undefined;
  let admitted = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Connections may close before their first request.
  void ready.catch(() => {});
  const pending = new Map<string, {
    resolve: (payload: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const handshakeTimer = setTimeout(() => fail(new Error("Paseo hello timeout")), timeoutMs);

  function fail(error: Error) {
    if (failure) return;
    failure = error;
    clearTimeout(handshakeTimer);
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    try { onFailure(error); } catch { /* Subscription cleanup cannot disrupt pending rejection. */ }
    try { ws.close(); } catch { /* already closed */ }
  }

  ws.onopen = () => {
    if (failure) return;
    try { ws.send(JSON.stringify(hello)); }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  };
  ws.onerror = () => fail(new Error("Paseo connection error"));
  ws.onclose = () => fail(new Error("Paseo connection closed"));
  ws.onmessage = (event) => {
    if (failure) return;
    let msg: any;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg?.type === "hello.rejected") {
      fail(new Error("Paseo hello rejected"));
      return;
    }
    if (msg?.type !== "session") return;
    const payload = msg.message?.payload;
    if (msg.message?.type === "status" && payload?.status === "server_info") {
      admitted = true;
      clearTimeout(handshakeTimer);
      resolveReady();
      return;
    }
    if (!admitted) return;
    try { onSession(msg.message); } catch (error) { log(`paseo subscription handler failed: ${String(error)}`); }
    const request = pending.get(payload?.requestId);
    if (!request) return;
    pending.delete(payload.requestId);
    clearTimeout(request.timer);
    log(`paseo sync response received for ${payload.requestId}`);
    request.resolve(payload);
  };

  async function requestWithId(requestId: string, message: Record<string, unknown>): Promise<any> {
    await ready;
    if (failure) throw failure;
    if (pending.has(requestId)) throw new Error(`Duplicate Paseo request: ${requestId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Paseo request timeout"));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        log(`paseo sync sending ${String(message.type ?? "unknown")} (requestId=${requestId})`);
        ws.send(JSON.stringify({ type: "session", message }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  return {
    request(build: (requestId: string) => Record<string, unknown>) {
      const requestId = randomUUID();
      return requestWithId(requestId, build(requestId));
    },
    requestWithId,
    close() { fail(new Error("Paseo connection closed")); },
  };
}
