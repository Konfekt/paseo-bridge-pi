// pi-paseo-bridge: makes terminal-started pi TUI sessions visible and
// steerable in Paseo without modifying Paseo.
//
// How it works: this extension runs inside the TUI process, opens a named
// pipe (Windows) / unix socket keyed on the session file path, and speaks
// pi's RPC JSONL dialect on it - the same dialect `pi --mode rpc` speaks on
// stdio. The companion shim (shim/pi-paseo-shim.js), configured as Paseo's
// pi provider command, connects Paseo's stdio to this pipe when the session
// has a live TUI, and falls through to the real pi otherwise.
//
// It also registers the session with the Paseo daemon (`paseo import`) on
// session start, which causes Paseo to spawn the shim and attach.
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { assertNoLiveRuntimeOwner, processStartToken } from "../shim/runtime-registry.js";
import { fileURLToPath } from "node:url";
import { paseoImportArgs, importRetryDelay } from "./import-placement.js";
import { type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "./bridge-transport.js";
import { isRuntimeReloadCommand, requireIdleReload, validateReloadPrompt } from "./reload-command.js";
import { abortAndWaitForIdle } from "./abort-dispatch.js";
import { dispatchPaseoPrompt } from "./prompt-dispatch.js";
import { remoteUserContent } from "./remote-user-content.js";
import { coordinateMirroredSelect } from "./mirrored-select.js";
import { createProviderReconnectLoop } from "./provider-reconnect.js";
import { unknownRpcCommandError } from "./rpc-compat.js";
import { buildSessionStats } from "./session-stats.js";
import { compactWithResult } from "./compaction-command.js";
import { projectedUserCaptures, readTextContent } from "./session-projection.js";
import { createPaseoWsConnection } from "./paseo-ws.js";
import { applyRemoteModel } from "./model-sync.js";
import { normalizePiEventForPaseo } from "./tool-result-normalization.js";
import { RPIV_INCOMPATIBILITY_WARNING } from "../scripts/config.js";
import { TurnVisibilityProjection } from "./turn-visibility.js";
import { bridgeSettingsFile, isAutoEnabled, isImportEnabled, writeBridgeSettings, writeMutableJson } from "./bridge-settings.js";

type PendingRemoteUiRequest = {
  method: "select" | "input" | "confirm";
  resolve(value: string | undefined): void;
  signal?: AbortSignal;
  abort?: () => void;
};

// Markers and command names must match Paseo's pi adapter
// (@getpaseo/server dist/server/server/agent/providers/pi/agent.js).
const ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const SUBMITTED_USER_ENTRY_MARKER = "PASEO_SUBMITTED_USER_ENTRY";
const COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const CAPTURE_COMMAND = "paseo_capture_entries";
const TREE_COMMAND = "paseo_tree";

// Keep in sync with shim/pi-paseo-shim.js (pipePathForSession).
function pipePathForSession(sessionFile: string): string {
  let normalized = path.resolve(sessionFile);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-paseo-bridge-${hash}`;
  const dir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo")
    : path.join(os.homedir(), ".pi", "paseo-bridge");
  return path.join(dir, `${hash}.sock`);
}

const DEBUG = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_DEBUG ?? "").toLowerCase());
const debugLogFile = path.join(os.homedir(), ".pi", "paseo-bridge", "debug.log");

function debugLog(message: string): void {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(path.dirname(debugLogFile), { recursive: true });
    fs.appendFileSync(debugLogFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // never let logging break the TUI
  }
}

function bridgeShimPath(): string {
  // extension/index.ts lives in <package root>/extension/
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = __dirname;
  }
  return path.join(path.dirname(here), "shim", "pi-paseo-shim.js");
}

const paseoConfigFile = path.join(os.homedir(), ".paseo", "config.json");

function readPaseoPassword(): string | null {
  const inline = process.env.PASEO_PASSWORD?.trim();
  if (inline) return inline;
  const passwordFile = process.env.PASEO_PASSWORD_FILE?.trim();
  if (!passwordFile) return null;
  try {
    const password = fs.readFileSync(passwordFile, "utf8").trim();
    return password || null;
  } catch (err) {
    debugLog(`could not read Paseo password file: ${String(err)}`);
    return null;
  }
}

function isOurShimCommand(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command.some(
      (part) => typeof part === "string" && part.replaceAll("\\", "/").toLowerCase().endsWith("/shim/pi-paseo-shim.js"),
    )
  );
}

// Returns a user-facing result message. Throws only on unreadable JSON.
function installShimIntoPaseoConfig(): { ok: boolean; message: string } {
  const config = fs.existsSync(paseoConfigFile) ? JSON.parse(fs.readFileSync(paseoConfigFile, "utf8")) : {};
  config.agents = config.agents ?? {};
  config.agents.providers = config.agents.providers ?? {};
  const current = config.agents.providers.pi?.command;
  if (isOurShimCommand(current)) {
    return { ok: true, message: "Paseo shim already installed" };
  }
  if (current) {
    return {
      ok: false,
      message: `Paseo config already overrides the pi provider command (${JSON.stringify(current)}). Remove agents.providers.pi.command from ~/.paseo/config.json first.`,
    };
  }
  config.agents.providers.pi = {
    ...(config.agents.providers.pi ?? {}),
    command: [process.execPath.replaceAll("\\", "/"), bridgeShimPath().replaceAll("\\", "/")],
  };
  writeMutableJson(paseoConfigFile, config);
  return { ok: true, message: "Paseo shim installed. Restart the Paseo daemon to apply: paseo restart" };
}

function uninstallShimFromPaseoConfig(): { ok: boolean; message: string } {
  if (!fs.existsSync(paseoConfigFile)) return { ok: true, message: "Paseo shim was not installed" };
  const config = JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"));
  const piProvider = config?.agents?.providers?.pi;
  if (!piProvider || !piProvider.command) {
    return { ok: true, message: "Paseo shim was not installed" };
  }
  if (!isOurShimCommand(piProvider.command)) {
    return {
      ok: false,
      message: `Leaving Paseo config untouched - the pi provider command is not the bridge shim: ${JSON.stringify(piProvider.command)}`,
    };
  }
  delete piProvider.command;
  if (Object.keys(piProvider).length === 0) delete config.agents.providers.pi;
  if (Object.keys(config.agents.providers).length === 0) delete config.agents.providers;
  if (Object.keys(config.agents).length === 0) delete config.agents;
  writeMutableJson(paseoConfigFile, config);
  return { ok: true, message: "Paseo shim removed. Restart the Paseo daemon to apply: paseo restart" };
}

function decodeCommandPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolvePaseoCli(): string | null {
  const override = process.env.PASEO_CLI;
  if (override && fs.existsSync(override)) return override;
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["paseo.cmd", "paseo.bat", "paseo.exe", "paseo"] : ["paseo"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const desktop = path.join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin", "paseo.cmd");
    if (fs.existsSync(desktop)) return desktop;
  }
  return null;
}

function runPaseoCli(cli: string, args: string[], onDone: (code: number | null, output: string) => void): void {
  let child;
  const password = readPaseoPassword();
  const env = password ? { ...process.env, PASEO_PASSWORD: password } : process.env;
  if (process.platform === "win32" && !cli.endsWith(".exe")) {
    // Node refuses to spawn .cmd files without a shell; go through cmd.exe
    // with /s so the outer quotes survive.
    const quoted = [cli, ...args].map((a) => `"${a.replaceAll('"', '""')}"`).join(" ");
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    });
  } else {
    child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], env });
  }
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 20000);
  child.on("error", (err) => {
    clearTimeout(timer);
    onDone(null, String(err));
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    onDone(code, output);
  });
}

export default function piPaseoBridge(pi: ExtensionAPI) {
  if (["0", "off", "false"].includes((process.env.PI_PASEO_BRIDGE ?? "").toLowerCase())) return;

  let transport: BridgeTransport | null = null;
  let currentSessionFile: string | null = null;
  let reloadRequested = false;
  let reloadExecuting = false;
  let commandsInFlight = 0;
  const pendingCommandReplies = new Map<symbol, (reason: string) => void>();
  let lifecycleClosed = false;
  let lifecycleAbortController = new AbortController();
  let latestCtx: ExtensionContext | null = null;
  let restoreTerminalUi: (() => void) | undefined;
  let isCompacting = false;
  // The extension API cannot read or change Pi's live auto-compaction setting.
  // Do not invent a separate bridge-local setting.
  const importAttempted = new Set<string>();
  let importFailures = 0;
  let importRetryAt = 0;
  let importTimer: ReturnType<typeof setInterval> | undefined;
  let currentAgentId: string | null = null;
  // Values Paseo just applied through the bridge; used to break the echo
  // loop when pushing TUI-side changes back to the daemon.
  let remoteAppliedModel: string | null = null;
  let remoteAppliedThinking: string | null = null;
  const submittedUserMessages: any[] = [];
  const pendingRemoteUiRequests = new Map<string, PendingRemoteUiRequest>();
  const turnVisibility = new TurnVisibilityProjection();
  const providerReconnect = createProviderReconnectLoop({
    shouldReconnect: () => Boolean(currentSessionFile && currentAgentId && !remoteUiConnected()),
    reload: reloadCurrentPaseoProvider,
    onError: (error) => debugLog(`paseo provider reattach failed: ${String(error)}`),
  });

  function reloadCurrentPaseoProvider(): Promise<void> {
    const agentId = currentAgentId;
    const cli = resolvePaseoCli();
    if (!agentId) return Promise.reject(new Error("Paseo agent ID is unavailable"));
    if (!cli) return Promise.reject(new Error("paseo CLI is unavailable"));
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    return new Promise((resolve, reject) => {
      runPaseoCli(cli, ["agent", "reload", agentId, "--json", ...hostArgs], (code, output) => {
        debugLog(`paseo provider reattach reload exited ${code}: ${output.slice(0, 200)}`);
        if (code === 0) resolve();
        else reject(new Error(output.trim() || `paseo agent reload exited ${String(code)}`));
      });
    });
  }

  function remoteUiConnected(): boolean {
    return transport?.connected ?? false;
  }

  function finishRemoteUiRequest(id: string, value: string | undefined): void {
    const pending = pendingRemoteUiRequests.get(id);
    if (!pending) return;
    pendingRemoteUiRequests.delete(id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(value);
  }

  function cancelPendingRemoteUiRequests(): void {
    for (const id of [...pendingRemoteUiRequests.keys()]) {
      cancelRemoteUiRequest(id);
    }
  }

  function cancelRemoteUiRequest(id: string): void {
    if (!pendingRemoteUiRequests.has(id)) return;
    finishRemoteUiRequest(id, undefined);
    // Stock Paseo does not consume extension_ui_cancel. Dismiss its question
    // using the same native permission-response route as an app cancellation.
    void resolvePaseoSelect(id, undefined);
  }

  function startRemoteDialog(
    request: { method: PendingRemoteUiRequest["method"]; title: string; options?: string[]; placeholder?: string; message?: string },
    signal?: AbortSignal,
  ): { id: string; result: Promise<string | undefined> } | null {
    if (!remoteUiConnected() || signal?.aborted) return null;
    const id = crypto.randomUUID();
    const result = new Promise<string | undefined>((resolve) => {
      const pending: PendingRemoteUiRequest = { method: request.method, resolve, signal };
      if (signal) {
        pending.abort = () => cancelRemoteUiRequest(id);
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      pendingRemoteUiRequests.set(id, pending);
      send({ type: "extension_ui_request", id, ...request });
    });
    return { id, result };
  }

  function bindTerminalDialogs(ctx: ExtensionContext): void {
    restoreTerminalUi?.();
    restoreTerminalUi = undefined;
    if (ctx.mode !== "tui") return;
    const ui = ctx.ui;
    const original = { select: ui.select, input: ui.input, confirm: ui.confirm };

    async function mirror(
      request: Parameters<typeof startRemoteDialog>[0],
      localDialog: (signal: AbortSignal) => Promise<string | undefined>,
      settings: ExtensionUIDialogOptions = {},
    ): Promise<string | undefined> {
      const controller = new AbortController();
      const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
      if (signal.aborted) return undefined;
      // The deadline also bounds a terminal decision awaiting controller delivery.
      const timer = settings.timeout === undefined ? undefined : setTimeout(() => controller.abort(), settings.timeout);
      const remote = startRemoteDialog(request, signal);
      try {
        if (!remote) return await localDialog(signal);
        return await coordinateMirroredSelect({
          remoteResult: remote.result,
          localSelect: localDialog,
          resolveLocal: value => resolvePaseoSelect(remote.id, value),
          signal,
        });
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (remote) cancelRemoteUiRequest(remote.id);
      }
    }

    const select: typeof ui.select = (title, options, settings) => {
      if (!remoteUiConnected()) return original.select.call(ui, title, options, settings);
      return mirror({ method: "select", title, options },
        signal => original.select.call(ui, title, options, { ...settings, signal }), settings);
    };
    const input: typeof ui.input = (title, placeholder, settings) => {
      if (!remoteUiConnected()) return original.input.call(ui, title, placeholder, settings);
      return mirror({ method: "input", title, placeholder },
        signal => original.input.call(ui, title, placeholder, { ...settings, signal }), settings);
    };
    const confirm: typeof ui.confirm = async (title, message, settings) => {
      if (!remoteUiConnected()) return original.confirm.call(ui, title, message, settings);
      // Pi's boolean confirm collapses No and Escape; its original selector
      // preserves cancellation so Paseo receives deny rather than a No answer.
      const value = await mirror({ method: "confirm", title, message },
        signal => original.select.call(ui, `${title}\n${message}`, ["Yes", "No"], { ...settings, signal }), settings);
      return value === "Yes";
    };
    ui.select = select;
    ui.input = input;
    ui.confirm = confirm;
    restoreTerminalUi = () => {
      if (ui.select === select) ui.select = original.select;
      if (ui.input === input) ui.input = original.input;
      if (ui.confirm === confirm) ui.confirm = original.confirm;
    };
  }

  function paseoWsUrl(): string | null {
    const host = process.env.PASEO_HOST?.trim();
    if (!host) return "ws://127.0.0.1:6767/ws";
    if (host.includes("://")) return null; // relay/offer URLs not supported for state sync
    return `ws://${host}/ws`;
  }

  // Opens a connection to the Paseo daemon's WS API (hello handshake, then
  // session-wrapped request/response correlated by requestId). Used for
  // state the daemon only accepts as client requests (it caches
  // model/thinking/titles and prefers the cache over anything visible
  // through the provider RPC surface).
  function openPaseoWs(): {
    request: (build: (requestId: string) => Record<string, unknown>) => Promise<any>;
    requestWithId: (requestId: string, message: Record<string, unknown>) => Promise<any>;
    close: () => void;
  } | null {
    const url = paseoWsUrl();
    if (!url) return null;
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (typeof WebSocketCtor !== "function") {
      debugLog("global WebSocket unavailable; cannot sync state to Paseo");
      return null;
    }
    const password = readPaseoPassword();
    const protocols = password ? [`paseo.bearer.${password}`] : undefined;
    const ws = new WebSocketCtor(url, protocols);
    debugLog(`paseo sync websocket connecting to ${url}`);
    return createPaseoWsConnection(ws, {
      type: "hello",
      clientId: `pi-paseo-bridge-${process.pid}`,
      clientType: "cli",
      protocolVersion: 1,
      // Stock Paseo sends direct permission acknowledgements only to sources
      // declaring owned subscriptions. No observation subscription is needed.
      capabilities: { owned_subscriptions: true, all_providers: true },
    }, { log: debugLog });
  }

  async function resolvePaseoSelect(requestId: string, value: string | undefined): Promise<void> {
    let conn: ReturnType<typeof openPaseoWs> = null;
    try {
      if (!currentAgentId) throw new Error("This session has no Paseo agent ID");
      conn = openPaseoWs();
      if (!conn) throw new Error("The Paseo daemon connection is unavailable");
      const response = value === undefined
        ? { behavior: "deny" }
        : { behavior: "allow", updatedInput: { answers: { Response: value } } };
      const payload = await conn.requestWithId(requestId, {
        type: "agent_permission_response",
        agentId: currentAgentId,
        requestId,
        response,
      });
      if (payload.error) throw new Error(payload.error);
    } catch (err) {
      debugLog(`paseo mirrored selection failed for ${requestId}: ${String(err)}`);
      const message = pendingRemoteUiRequests.has(requestId)
        ? "Terminal choice was not submitted. Respond to the question in Paseo."
        : "Could not dismiss the cancelled question in Paseo. Dismiss it in the app.";
      notifyTui(message);
      notifyEvent(message);
    } finally {
      conn?.close();
    }
  }

  function paseoSessionRequest(buildMessage: (requestId: string) => Record<string, unknown>, label: string): void {
    const conn = openPaseoWs();
    if (!conn) return;
    conn
      .request(buildMessage)
      .then((payload) => {
        const ok = payload.accepted ?? payload.ok;
        debugLog(`paseo sync ${label}: ${ok ? "accepted" : `rejected: ${payload.error}`}`);
      })
      .catch((err) => debugLog(`paseo sync ${label}: ${String(err?.message ?? err)}`))
      .finally(() => conn.close());
  }

  function pushAgentConfigToPaseo(kind: "model" | "thinking", value: string | null): void {
    if (!currentAgentId) return;
    const agentId = currentAgentId;
    paseoSessionRequest(
      (requestId) =>
        kind === "model"
          ? { type: "set_agent_model_request", agentId, modelId: value, requestId }
          : { type: "set_agent_thinking_request", agentId, thinkingOptionId: value, requestId },
      `${kind}=${value}`,
    );
  }

  function modelToId(model: { provider?: string; id?: string } | null | undefined): string | null {
    return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
  }

  function send(obj: unknown): void {
    transport?.send(obj);
  }

  function notifyTui(message: string): void {
    if (latestCtx?.mode !== "tui") return;
    try {
      latestCtx.ui.notify(message, "info");
    } catch (err) {
      debugLog(`notifyTui failed: ${String(err)}`);
    }
  }

  function notifyEvent(message: string): void {
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "notify",
      message,
      notifyType: "info",
    });
  }

  function toCapturedUserEntry(entry: any): { id: string; parentId: string | null; text: string } {
    return {
      id: entry.id,
      parentId: entry.parentId ?? null,
      text: readTextContent(entry.message.content),
    };
  }

  function capturedUserEntries(ctx: ExtensionContext): Array<{ id: string; parentId: string | null; text: string }> {
    return ctx.sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
      .map(toCapturedUserEntry);
  }

  function emitSubmittedUserEntries(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    for (let index = 0; index < submittedUserMessages.length; index += 1) {
      const message = submittedUserMessages[index];
      const entry = entries.find(
        (candidate: any) => candidate.type === "message" && candidate.message === message,
      );
      if (!entry) continue;
      submittedUserMessages.splice(index, 1);
      index -= 1;
      notifyEvent(`${SUBMITTED_USER_ENTRY_MARKER} ${JSON.stringify({ entry: toCapturedUserEntry(entry) })}`);
    }
  }

  function emitEntryCapture(ctx: ExtensionContext | null, reason: string, requestId?: string): void {
    if (!ctx) return;
    try {
      const sm = ctx.sessionManager;
      const treeEntries = capturedUserEntries(ctx);
      const history = buildSessionProjection(sm.getEntries(), sm.getLeafId());
      const contextEntries = projectedUserCaptures(history.entries);
      notifyEvent(`${ENTRY_CAPTURE_MARKER} ${JSON.stringify({ reason, requestId, treeEntries, contextEntries })}`);
    } catch (err) {
      debugLog(`entry capture failed: ${String(err)}`);
    }
  }

  function emitCommandResult(requestId: string, result: { ok: boolean; result?: unknown; error?: string }): void {
    notifyEvent(`${COMMAND_RESULT_MARKER} ${JSON.stringify({ requestId, ...result })}`);
  }

  const success = (id: unknown, command: string, data?: unknown) => ({
    type: "response",
    id,
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
  const failure = (id: unknown, command: string, error: string) => ({
    type: "response",
    id,
    command,
    success: false,
    error,
  });

  function buildState(): Record<string, unknown> {
    const ctx = latestCtx;
    const sm = ctx?.sessionManager;
    const messageCount = sm ? sm.getEntries().filter((e: any) => e.type === "message").length : 0;
    return {
      model: ctx?.model ?? null,
      thinkingLevel: pi.getThinkingLevel(),
      isStreaming: ctx ? !ctx.isIdle() : false,
      isCompacting,
      sessionFile: sm?.getSessionFile(),
      sessionId: sm?.getSessionId(),
      sessionName: sm?.getSessionName(),
      bridgeCapabilities: { supportsRewindConversation: false, supportsAutoCompactionControl: false },
      messageCount,
      pendingMessageCount: ctx?.hasPendingMessages() ? 1 : 0,
      contextUsage: ctx?.getContextUsage(),
    };
  }

  function commandNotices(reply: (frame: unknown) => void) {
    return (message: string, notifyType: "info" | "warning" | "error") => reply({
      type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType,
    });
  }

  async function handlePrompt(cmd: any, send: (frame: unknown) => void): Promise<void> {
    const message: string = typeof cmd.message === "string" ? cmd.message : "";
    if (/^\/reload(?:\s|$)/.test(message.trim())) {
      throw new Error("Unsupported command: /reload is terminal-only. Use /remote-reload to reload Pi from Paseo while idle.");
    }
    if (isRuntimeReloadCommand(message)) {
      validateReloadPrompt(message, cmd.images);
      requireIdleReload(latestCtx, { reloading: reloadRequested, compacting: isCompacting,
        pendingUi: pendingRemoteUiRequests.size > 0, pendingRpc: commandsInFlight > 1 });
      reloadRequested = true;
      // Acknowledge acceptance before teardown. Completion is emitted by the
      // replacement session_start handler, never through the stale Pi API.
      send(success(cmd.id, "prompt", { agentInvoked: false, reloadAccepted: true }));
      try { pi.sendUserMessage("/remote-reload", { expandPromptTemplates: true }); }
      catch (error) {
        reloadRequested = false;
        notifyEvent(`Pi runtime reload failed: ${String(error).slice(0, 2000)}`);
      }
      return;
    }
    if (message.startsWith(`/${CAPTURE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(CAPTURE_COMMAND.length + 1));
      emitEntryCapture(latestCtx, "command", typeof payload?.requestId === "string" ? payload.requestId : undefined);
      send(success(cmd.id, "prompt"));
      return;
    }
    if (message.startsWith(`/${TREE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(TREE_COMMAND.length + 1));
      if (typeof payload?.requestId === "string") {
        emitCommandResult(payload.requestId, {
          ok: false,
          error: "Timeline rewind is not supported for terminal-attached pi sessions",
        });
      }
      send(success(cmd.id, "prompt"));
      return;
    }
    if (await handleBridgeManagement(cmd, send)) return;
    const content = remoteUserContent(message, cmd.images);
    const streaming = latestCtx ? !latestCtx.isIdle() : false;
    const result = await dispatchPaseoPrompt(pi, content, message, streaming);
    send(success(cmd.id, "prompt", result));
  }

  async function handleBridgeManagement(cmd: any, send: (frame: unknown) => void): Promise<boolean> {
    const message = typeof cmd.message === "string" ? cmd.message : "";
    if (message !== "/paseo-bridge" && !message.startsWith("/paseo-bridge ")) return false;
    if (Array.isArray(cmd.images) && cmd.images.length) throw new Error("Extension commands do not accept image attachments. Send images as an ordinary prompt.");
    if (!latestCtx) throw new Error("Pi session is not ready.");
    const args = message.slice("/paseo-bridge".length).trimStart();
    // Disconnect is acceptance-only: the transport cannot report its own
    // completed teardown. Never present this receipt as command completion.
    if (args.trim().split(/\s+/)[0] === "disconnect") {
      send(success(cmd.id, cmd.type, { agentInvoked: false, disconnectAccepted: true }));
      stopServer();
      return true;
    }
    await runBridgeManagement(args, latestCtx, true, commandNotices(send));
    send(success(cmd.id, cmd.type, { agentInvoked: false }));
    return true;
  }

  async function handleCommand(cmd: any): Promise<void> {
    // Completion and notifications belong to the requesting controller, never
    // to a replacement connection or extension binding after an awaited command.
    const owner = transport;
    const epoch = owner?.connectionEpoch;
    const lease = Symbol("command reply");
    let settled = false;
    const send = (frame: unknown) => {
      if (settled) return;
      if (frame && typeof frame === "object" && "type" in frame && frame.type === "response") {
        settled = true;
        pendingCommandReplies.delete(lease);
      }
      if (owner && owner === transport && owner.connected && owner.connectionEpoch === epoch) owner.send(frame);
    };
    const id = cmd.id;
    const type: string = cmd.type;
    pendingCommandReplies.set(lease, reason => send(failure(id, type, reason)));
    commandsInFlight += 1;
    try {
      if (reloadRequested) {
        send(failure(id, type, "Pi runtime reload is in progress; retry after it completes."));
        return;
      }
      switch (type) {
        case "prompt":
          await handlePrompt(cmd, send);
          return;
        case "steer":
        case "follow_up": {
          if (typeof cmd.message !== "string") throw new Error("Message must be a string");
          if (/^\/(?:remote-reload|reload)(?:\s|$)/.test(cmd.message.trim())) {
            throw new Error("Reload must be sent as an ordinary prompt while Pi is idle.");
          }
          if (await handleBridgeManagement(cmd, send)) return;
          const result = await dispatchPaseoPrompt(pi, remoteUserContent(cmd.message, cmd.images),
            cmd.message, false, type === "steer" ? "steer" : "followUp");
          send(success(id, type, result));
          return;
        }
        case "abort":
          cancelPendingRemoteUiRequests();
          // Capture this lifecycle's context and signal. Never use ctx.signal:
          // that signal belongs to turn work, not the lifetime of this waiter.
          await abortAndWaitForIdle(latestCtx, { signal: lifecycleAbortController.signal });
          send(success(id, type));
          return;
        case "get_state":
          send(success(id, type, buildState()));
          return;
        case "get_messages": {
          const sm = latestCtx?.sessionManager;
          const history = sm ? buildSessionProjection(sm.getEntries(), sm.getLeafId()) : { messages: [] };
          send(success(id, type, { messages: history.messages }));
          return;
        }
        case "get_available_models":
          send(success(id, type, { models: latestCtx?.modelRegistry.getAvailable() ?? [] }));
          return;
        case "set_model": {
          const model = latestCtx?.modelRegistry.find(cmd.provider, cmd.modelId);
          if (!model) {
            send(failure(id, type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          const ok = await applyRemoteModel(latestCtx?.model, model, async (nextModel) => {
            remoteAppliedModel = modelToId(nextModel);
            return pi.setModel(nextModel);
          });
          if (!ok) {
            send(failure(id, type, `No API key available for ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          send(success(id, type, model));
          return;
        }
        case "set_thinking_level":
          remoteAppliedThinking = cmd.level;
          pi.setThinkingLevel(cmd.level);
          send(success(id, type));
          return;
        case "get_session_stats":
          send(success(id, type, buildSessionStats(latestCtx)));
          return;
        case "get_commands":
          send(success(id, type, { commands: pi.getCommands() }));
          return;
        case "compact": {
          if (!latestCtx) throw new Error("No active session context");
          if (isCompacting) throw new Error("A Pi compaction is already running");
          // Reserve immediately: session_before_compact runs only after preparation.
          isCompacting = true;
          try {
            const result = await compactWithResult(latestCtx, cmd.customInstructions || undefined);
            send(success(id, type, result));
          } finally {
            isCompacting = false;
          }
          return;
        }
        case "set_auto_compaction":
          send(failure(id, type, "Auto-compaction control is unsupported by this Pi extension API"));
          return;
        case "extension_ui_response": {
          const requestId = String(cmd.id ?? "");
          const pending = pendingRemoteUiRequests.get(requestId);
          const value = cmd.cancelled === true ? undefined
            : pending?.method === "confirm" && typeof cmd.confirmed === "boolean" ? (cmd.confirmed ? "Yes" : "No")
            : typeof cmd.value === "string" ? cmd.value : undefined;
          finishRemoteUiRequest(requestId, value);
          return;
        }
        default:
          // Paseo uses Pi's native error text to detect optional RPCs. In
          // particular, 0.7.2 falls back from clear_queue before aborting.
          send(failure(id, type ?? "unknown", unknownRpcCommandError(type)));
      }
    } catch (err) {
      debugLog(`command ${type} failed: ${String(err)}`);
      send(failure(id, type ?? "unknown", err instanceof Error ? err.message : String(err)));
    } finally {
      pendingCommandReplies.delete(lease);
      commandsInFlight -= 1;
    }
  }

  function bindTransport(): void {
    transport?.bind({
      command: handleCommand,
      attached() {
        providerReconnect.connected();
        debugLog("client connected");
        notifyTui("Paseo attached to this session");
        emitEntryCapture(latestCtx, "session_start");
      },
      detached() {
        for (const reject of [...pendingCommandReplies.values()]) reject("Paseo controller disconnected before the command completed; its outcome is unknown.");
        cancelPendingRemoteUiRequests();
        lifecycleAbortController.abort();
        lifecycleAbortController = new AbortController();
        providerReconnect.trigger();
        debugLog("client disconnected");
      },
      error: (error) => debugLog(`bridge transport error: ${String(error)}`),
    });
  }

  function stopServer(): void {
    providerReconnect.stop();
    cancelPendingRemoteUiRequests();
    lifecycleAbortController.abort();
    transport?.close();
    transport = null;
    currentSessionFile = null;
    currentAgentId = null;
    remoteAppliedModel = null;
    remoteAppliedThinking = null;
  }

  function startServer(sessionFile: string): void {
    assertNoLiveRuntimeOwner(sessionFile, { ignorePid: process.pid });
    // connectSession stops the previous server even on first connection.
    // Its aborted signal belongs to that old lifecycle, never the new server.
    lifecycleAbortController = new AbortController();
    transport = new BridgeTransport(sessionFile, pipePathForSession(sessionFile));
    currentSessionFile = sessionFile;
    bindTransport();
    transport.start();
  }

  const agentMapFile = path.join(os.homedir(), ".pi", "paseo-bridge", "agents.json");
  const runtimeRegistryDir = path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes");

  function runtimeRecordFile(sessionFile: string): string {
    const key = crypto.createHash("sha256").update(agentMapKey(sessionFile)).digest("hex");
    return path.join(runtimeRegistryDir, `${key}.json`);
  }

  function writeRuntimeRecord(sessionFile: string, cwd: string): void {
    try {
      fs.mkdirSync(runtimeRegistryDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(runtimeRegistryDir, 0o700);
      const destination = runtimeRecordFile(sessionFile);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 2,
        processStartToken: processStartToken(),
        sessionFile: path.resolve(sessionFile),
        bridgeSocket: pipePathForSession(sessionFile),
        agentId: currentAgentId,
        cwd,
        pid: process.pid,
      }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, destination);
    } catch (err) {
      debugLog(`could not write runtime record: ${String(err)}`);
    }
  }

  function removeRuntimeRecord(sessionFile: string): void {
    try {
      const destination = runtimeRecordFile(sessionFile);
      const record = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (record?.pid === process.pid) fs.unlinkSync(destination);
    } catch {
      // absent, stale, or replaced by a newer owner
    }
  }

  function agentMapKey(sessionFile: string): string {
    const resolved = path.resolve(sessionFile);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function readAgentMap(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(agentMapFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAgentMapEntry(sessionFile: string, agentId: string): void {
    try {
      fs.mkdirSync(path.dirname(agentMapFile), { recursive: true });
      const map = readAgentMap();
      map[agentMapKey(sessionFile)] = agentId;
      fs.writeFileSync(agentMapFile, `${JSON.stringify(map, null, 2)}\n`);
    } catch (err) {
      debugLog(`could not persist agent map: ${String(err)}`);
    }
  }

  function adoptAgent(agentId: string, reused: boolean): void {
    currentAgentId = agentId;
    if (currentSessionFile && latestCtx) writeRuntimeRecord(currentSessionFile, latestCtx.cwd);
    debugLog(`paseo agent id: ${agentId}${reused ? " (reused)" : ""}`);
    // Align Paseo's cached model/thinking with the TUI's live values. The
    // import-time descriptor scan can be stale or empty.
    pushAgentConfigToPaseo("model", modelToId(latestCtx?.model));
    pushAgentConfigToPaseo("thinking", pi.getThinkingLevel() ?? null);
    notifyTui(reused ? "Session reconnected in Paseo" : "Session imported into Paseo");
    if (latestCtx) syncSessionName(latestCtx);
  }

  function registerWithPaseo(sessionFile: string, cwd: string): void {
    if (importAttempted.has(sessionFile) || lifecycleClosed || Date.now() < importRetryAt) return;
    const isCurrent = () => !lifecycleClosed && currentSessionFile === sessionFile;
    importAttempted.add(sessionFile);
    if (!isImportEnabled()) return;
    const cli = resolvePaseoCli();
    if (!cli) {
      debugLog("paseo CLI not found; session will not auto-appear (set PASEO_CLI)");
      return;
    }
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    const retryImport = () => {
      // Keep retries slow while the local daemon is unavailable.
      const delay = importRetryDelay(++importFailures) ?? 60_000;
      importRetryAt = Date.now() + delay;
      importAttempted.delete(sessionFile);
    };
    const runImport = () => {
      const args = paseoImportArgs({ sessionFile, cwd, host: process.env.PASEO_HOST });
      runPaseoCli(cli, args, (code, output) => {
        if (!isCurrent()) return;
        debugLog(`paseo import exited ${code}: ${output.slice(0, 500)}`);
        if (code !== 0) {
          retryImport();
          return;
        }
        try {
          const jsonStart = output.indexOf("{");
          if (jsonStart === -1) return;
          const result = JSON.parse(output.slice(jsonStart));
          if (typeof result.agentId === "string" && result.agentId) {
            writeAgentMapEntry(sessionFile, result.agentId);
            adoptAgent(result.agentId, false);
          }
        } catch (err) {
          debugLog(`could not parse import output: ${String(err)}`);
        }
      });
    };
    // Re-importing a session Paseo already knows creates a duplicate agent,
    // so check the last known agent for this session file first.
    const knownAgentId = readAgentMap()[agentMapKey(sessionFile)];
    if (!knownAgentId) {
      runImport();
      return;
    }
    runPaseoCli(cli, ["inspect", knownAgentId, "--json", ...hostArgs], (code, output) => {
      if (!isCurrent()) return;
      let exists = false;
      try {
        if (code === 0) {
          const jsonStart = output.indexOf("{");
          const info = jsonStart === -1 ? null : JSON.parse(output.slice(jsonStart));
          exists = Boolean(info) && info.Archived !== true;
        }
      } catch (err) {
        debugLog(`inspect of known agent failed: ${String(err)}`);
      }
      if (!exists) {
        runImport();
        return;
      }
      // The daemon's provider session for this agent died with the previous
      // TUI process; reload restarts it so it reattaches to the new pipe.
      runPaseoCli(cli, ["agent", "reload", knownAgentId, "--json", ...hostArgs], (reloadCode, reloadOutput) => {
        if (!isCurrent()) return;
        debugLog(`paseo agent reload exited ${reloadCode}: ${reloadOutput.slice(0, 200)}`);
        if (reloadCode === 0) {
          adoptAgent(knownAgentId, true);
        } else {
          runImport();
        }
      });
    });
  }

  function connectSession(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return "This session is ephemeral (--no-session); nothing to bridge.";
    if (file !== currentSessionFile) {
      stopServer();
      startServer(file);
    }
    writeRuntimeRecord(file, ctx.cwd);
    importAttempted.delete(file);
    importFailures = 0;
    importRetryAt = 0;
    registerWithPaseo(file, ctx.cwd);
    return "Connecting session to Paseo...";
  }

  pi.on("session_start", async (event, ctx) => {
    cancelPendingRemoteUiRequests();
    lifecycleClosed = false;
    bindTerminalDialogs(ctx);
    lifecycleAbortController.abort();
    lifecycleAbortController = new AbortController();
    latestCtx = ctx;
    const retained = event.reason === "reload"
      ? takeBridgeAfterReload(ctx.sessionManager.getSessionFile())
      : (discardRetainedBridge(), undefined);
    try {
      const force = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_FORCE ?? "").toLowerCase());
      if (ctx.mode !== "tui" && !force) {
        retained?.transport.close();
        if (event.reason === "reload" && ctx.hasUI) ctx.ui.notify("Pi runtime reloaded.", "info");
        return;
      }
      if (retained) {
        transport = retained.transport;
        currentSessionFile = transport.sessionFile;
        currentAgentId = retained.agentId;
        bindTransport();
        writeRuntimeRecord(currentSessionFile, ctx.cwd);
        // Keep the existing provider and socket. Restarting it here would turn
        // a harmless extension reload into a Paseo process_exit/tombstone.
        if (currentAgentId) {
          importAttempted.add(currentSessionFile);
          if (!remoteUiConnected()) providerReconnect.trigger();
        } else registerWithPaseo(currentSessionFile, ctx.cwd);
      } else {
        if (!isAutoEnabled()) return;
        connectSession(ctx);
      }
      importTimer = setInterval(() => {
        if (!lifecycleClosed && currentSessionFile && latestCtx && !currentAgentId) {
          registerWithPaseo(currentSessionFile, latestCtx.cwd);
        }
      }, 2000);
      importTimer.unref();
      if (event.reason === "reload") notifyEvent("Pi runtime reloaded. Background jobs were not cancelled.");
    } catch (err) {
      retained?.transport.close();
      debugLog(`session_start failed: ${String(err)}`);
    }
  });

  pi.on("session_shutdown", async (event) => {
    // Reload retains the controller socket: settle old command RPCs before its
    // owner is suspended, rather than hanging them or replying into a new binding.
    for (const reject of [...pendingCommandReplies.values()]) {
      reject(event.reason === "reload"
        ? "Pi runtime reloaded before the command completed; its outcome is unknown."
        : "Pi session closed before the command completed; its outcome is unknown.");
    }
    lifecycleClosed = true;
    restoreTerminalUi?.();
    restoreTerminalUi = undefined;
    lifecycleAbortController.abort();
    latestCtx = null;
    if (importTimer) clearInterval(importTimer);
    importTimer = undefined;
    if (event.reason === "reload" && transport) {
      providerReconnect.stop();
      cancelPendingRemoteUiRequests();
      lifecycleAbortController.abort();
      retainBridgeForReload(transport, currentAgentId);
      transport = null;
    } else {
      discardRetainedBridge();
      if (currentSessionFile) removeRuntimeRecord(currentSessionFile);
      stopServer();
    }
  });

  const forwardEvents = [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
    "agent_settled",
  ] as const;
  for (const eventName of forwardEvents) {
    (pi as any).on(eventName, async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      const normalized = normalizePiEventForPaseo(event);
      for (const visible of turnVisibility.project(normalized as Record<string, any>)) {
        send(visible);
      }
    });
  }

  pi.on("message_end", async (event: any) => {
    if (event.message?.role === "user") submittedUserMessages.push(event.message);
  });

  pi.on("message_start", async (event: any, ctx) => {
    if (event.message?.role === "assistant") emitSubmittedUserEntries(ctx);
  });

  function syncSessionName(ctx: ExtensionContext): void {
    const name = ctx.sessionManager.getSessionName();
    const agentId = currentAgentId;
    if (!agentId || !name) return;
    paseoSessionRequest(requestId => ({ type: "update_agent_request", agentId, name, requestId }), "session name");
  }

  pi.on("session_info_changed", (_event, ctx) => syncSessionName(ctx));

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    send(event);
    emitSubmittedUserEntries(ctx);
    emitEntryCapture(ctx, "turn_end");
  });

  pi.on("session_before_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = true;
    send({ type: "compaction_start", reason: event?.reason });
    return undefined;
  });

  pi.on("session_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = false;
    send({ type: "compaction_end", reason: event?.reason, ...(event?.compactionEntry ? { result: event.compactionEntry } : {}) });
  });

  pi.on("session_compact_failed", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = false;
    send({ type: "compaction_end", reason: event?.reason, errorMessage: event?.error?.message ?? event?.errorMessage, aborted: event?.aborted === true });
  });

  pi.on("model_select", async (event, ctx) => {
    latestCtx = ctx;
    const modelId = modelToId(event.model);
    if (modelId === remoteAppliedModel) {
      remoteAppliedModel = null;
      return;
    }
    pushAgentConfigToPaseo("model", modelId);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    latestCtx = ctx;
    if (event.level === remoteAppliedThinking) {
      remoteAppliedThinking = null;
      return;
    }
    pushAgentConfigToPaseo("thinking", event.level ?? null);
  });

  const reloadRuntime = async (args: string, ctx: ExtensionCommandContext) => {
    validateReloadPrompt(`/remote-reload ${args}`);
    requireIdleReload(ctx, { reloading: reloadExecuting, compacting: isCompacting,
      pendingUi: pendingRemoteUiRequests.size > 0, pendingRpc: commandsInFlight > (reloadRequested ? 1 : 0) });
    reloadRequested = true;
    reloadExecuting = true;
    const connection = transport;
    notifyEvent("Reloading Pi runtime; the Pi process and background jobs will keep running.");
    try {
      await ctx.reload();
      return; // The old pi/ctx are invalid after reload.
    } catch (error) {
      reloadRequested = false;
      reloadExecuting = false;
      // Only the independently owned transport is safe to use after teardown.
      connection?.send({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify",
        message: `Pi runtime reload failed: ${String(error).slice(0, 2000)}`, notifyType: "error" });
      throw error;
    }
  };
  pi.registerCommand("remote-reload", {
    description: "Reload Pi extensions and resources while idle, without restarting Pi or cancelling background jobs",
    handler: reloadRuntime,
  });

  async function runBridgeManagement(args: string, ctx: ExtensionContext, reportFailure = false,
    notify: (message: string, type: "info" | "warning" | "error") => void = (message, type) => ctx.ui.notify(message, type),
  ): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        switch (sub) {
          case "install": {
            notify(RPIV_INCOMPATIBILITY_WARNING, "warning");
            const result = installShimIntoPaseoConfig();
            if (reportFailure && !result.ok) throw new Error(result.message);
            notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "uninstall": {
            const result = uninstallShimFromPaseoConfig();
            if (reportFailure && !result.ok) throw new Error(result.message);
            notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "auto": {
            const value = parts[1]?.toLowerCase();
            if (value !== "on" && value !== "off") {
              notify(`Auto-connect is ${isAutoEnabled() ? "on" : "off"}. Use /paseo-bridge auto on|off to change.`, "info");
              return;
            }
            writeBridgeSettings({ auto: value === "on" });
            notify(`Auto-connect ${value}: new TUI sessions will ${value === "on" ? "" : "not "}appear in Paseo automatically.`, "info");
            return;
          }
          case "connect":
            notify(connectSession(ctx), "info");
            return;
          case "disconnect":
            if (!transport) {
              notify("Bridge is not connected.", "info");
              return;
            }
            stopServer();
            notify("Bridge disconnected. Use /paseo-bridge connect to reattach.", "info");
            return;
          case "status": {
            let shimInstalled = false;
            try {
              shimInstalled = isOurShimCommand(
                JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"))?.agents?.providers?.pi?.command,
              );
            } catch {
              // unreadable config counts as not installed
            }
            const lines = [
              `shim: ${shimInstalled ? "installed" : "not installed (run /paseo-bridge install)"}`,
              `auto-connect: ${isAutoEnabled() ? "on" : "off"}`,
              `settings: ${bridgeSettingsFile()}`,
              `session import: ${isImportEnabled() ? "on" : "off"}`,
              `session: ${transport ? (currentAgentId ? `bridged as Paseo agent ${currentAgentId}` : "bridged (not yet imported)") : "not bridged"}`,
            ];
            notify(`Paseo bridge status\n${lines.join("\n")}`, "info");
            return;
          }
          default:
            if (reportFailure) throw new Error("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status");
            notify("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status", "warning");
        }
      } catch (err) {
        if (reportFailure) throw err;
        notify(`paseo-bridge: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
  }
  pi.registerCommand("paseo-bridge", {
    description: "Manage the Paseo bridge: install | uninstall | auto [on|off] | connect | disconnect | status",
    handler: (args, ctx) => runBridgeManagement(args, ctx),
  });
}
