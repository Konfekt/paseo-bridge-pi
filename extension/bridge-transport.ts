import * as net from "node:net";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_CONTROLLER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_CONTROLLER_WRITE_QUEUE_BYTES = 32 * 1024 * 1024;
const RELOAD_ADOPTION_TIMEOUT_MS = 90_000;

type Callbacks = {
  command(value: any): Promise<void>;
  attached(): void;
  detached(): void;
  error(error: unknown): void;
};

/** One private controller socket, retained across same-session extension reload. */
export class BridgeTransport {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private callbacks?: Callbacks;
  private closed = false;
  private _connectionEpoch = randomUUID();

  readonly sessionFile: string;
  readonly pipePath: string;

  constructor(sessionFile: string, pipePath: string) {
    this.sessionFile = sessionFile;
    this.pipePath = pipePath;
  }

  get connected(): boolean { return Boolean(this.client && !this.client.destroyed); }
  /** Bind replies to the controller and extension context that admitted them. */
  get connectionEpoch(): string { return this._connectionEpoch; }

  bind(callbacks: Callbacks): void {
    this._connectionEpoch = randomUUID();
    this.callbacks = callbacks;
    if (this.connected) callbacks.attached();
  }

  suspend(): void {
    this._connectionEpoch = randomUUID();
    this.callbacks = undefined;
  }

  start(): void {
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.pipePath), { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(this.pipePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.server = net.createServer(socket => this.attach(socket));
    this.server.on("error", error => this.callbacks?.error(error));
    this.server.listen(this.pipePath, () => {
      if (process.platform !== "win32") {
        try { fs.chmodSync(this.pipePath, 0o600); }
        catch (error) { this.callbacks?.error(error); this.close(); }
      }
    });
  }

  send(value: unknown): void {
    if (!this.connected) return;
    const socket = this.client!;
    try {
      const frame = `${JSON.stringify(value)}\n`;
      const frameBytes = Buffer.byteLength(frame);
      if (frameBytes > MAX_CONTROLLER_FRAME_BYTES) {
        this.callbacks?.error(new Error("Controller output frame exceeds the 16 MiB limit"));
        socket.destroy();
        return;
      }
      if (socket.writableLength + frameBytes > MAX_CONTROLLER_WRITE_QUEUE_BYTES) {
        this.callbacks?.error(new Error("Controller write queue exceeds the 32 MiB limit"));
        socket.destroy();
        return;
      }
      socket.write(frame);
    } catch (error) { this.callbacks?.error(error); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.suspend();
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    this.server = null;
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.pipePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private attach(socket: net.Socket): void {
    const detach = () => {
      if (this.client !== socket) return;
      this.client = null;
      this._connectionEpoch = randomUUID();
      this.callbacks?.detached();
    };
    // Own errors even on a rejected secondary controller.
    socket.on("error", error => { this.callbacks?.error(error); detach(); });
    socket.on("close", detach);
    if (this.closed || this.client) {
      socket.end(`${JSON.stringify({ type: "response", id: null, command: "connect", success: false,
        error: "pi-paseo-bridge: another controller is already attached to this session" })}\n`);
      return;
    }
    this.client = socket;
    this._connectionEpoch = randomUUID();
    socket.setNoDelay(true);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        const frame = newline < 0 ? buffer : buffer.slice(0, newline);
        if (Buffer.byteLength(frame) > MAX_CONTROLLER_FRAME_BYTES) {
          this.callbacks?.error(new Error("Controller input frame exceeds the 16 MiB limit"));
          socket.destroy();
          return;
        }
        if (newline < 0) break;
        const line = frame.replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let command: any;
        try { command = JSON.parse(line); }
        catch { continue; }
        if (!command || typeof command !== "object" || Array.isArray(command)) continue;
        const callbacks = this.callbacks;
        if (!callbacks) {
          this.send({ type: "response", id: command.id, command: command.type, success: false,
            error: "Pi runtime reload is in progress; retry after it completes." });
          continue;
        }
        void callbacks.command(command).catch(error => callbacks.error(error));
      }
    });
    this.callbacks?.attached();
  }
}

type RetainedBridge = {
  transport: BridgeTransport;
  agentId: string | null;
  timer: ReturnType<typeof setTimeout>;
};
const RELOAD_BRIDGE_KEY = "__piPaseoReloadTransportV1";

/** Same-process, same-session handoff; abandoned reloads release the socket. */
export function retainBridgeForReload(
  transport: BridgeTransport,
  agentId: string | null,
  timeoutMs = RELOAD_ADOPTION_TIMEOUT_MS,
): void {
  discardRetainedBridge();
  transport.suspend();
  const root = globalThis as Record<string, unknown>;
  const retained: RetainedBridge = {
    transport, agentId,
    timer: setTimeout(() => {
      if (root[RELOAD_BRIDGE_KEY] === retained) discardRetainedBridge();
    }, timeoutMs),
  };
  retained.timer.unref?.();
  root[RELOAD_BRIDGE_KEY] = retained;
}

export function takeBridgeAfterReload(sessionFile: string | undefined): Omit<RetainedBridge, "timer"> | undefined {
  const root = globalThis as Record<string, unknown>;
  const retained = root[RELOAD_BRIDGE_KEY] as RetainedBridge | undefined;
  if (!retained) return undefined;
  if (retained.transport.sessionFile !== sessionFile) {
    discardRetainedBridge();
    return undefined;
  }
  delete root[RELOAD_BRIDGE_KEY];
  clearTimeout(retained.timer);
  // Replace methods without changing ownership of the live server and socket.
  Object.setPrototypeOf(retained.transport, BridgeTransport.prototype);
  return { transport: retained.transport, agentId: retained.agentId };
}

export function discardRetainedBridge(): void {
  const root = globalThis as Record<string, unknown>;
  const retained = root[RELOAD_BRIDGE_KEY] as RetainedBridge | undefined;
  if (!retained) return;
  delete root[RELOAD_BRIDGE_KEY];
  clearTimeout(retained.timer);
  retained.transport.close();
}
