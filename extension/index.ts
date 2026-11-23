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
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  buildSessionProjection,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  assertNoLiveRuntimeOwner,
  bridgeStateDirectory,
  pipePathForSession,
  processStartToken,
  runtimeRecordFile,
  runtimeRegistryDirectory,
  sessionKey,
} from "../shim/runtime-registry.js";
import { FRAME_MARKER, SHIM_PROTOCOL_ENV } from "../shim/protocol.js";
import { jsonLine, lineReader } from "../shim/jsonl.js";
import {
  addShimToPaseoConfig,
  isOurShimCommand,
  paseoConfigPath,
  removeShimFromPaseoConfig,
  RPIV_INCOMPATIBILITY_WARNING,
} from "../scripts/config.js";
import {
  firstUserPrompt,
  findImportedPiAgent,
  importIntoSessionWorkspace,
  importRetryDelay,
  paseoImportArgs,
  reusePaseoAgent,
  sessionFileSaved,
  sessionWorkspaceId,
  sessionWorkspaceTitle,
  workspaceTitleRequest,
} from "./import-placement.js";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "./bridge-transport.js";
import { isRuntimeReloadCommand, requireIdleReload, validateReloadPrompt } from "./reload-command.js";
import { abortAndAcknowledge, waitForSettlement } from "./abort-dispatch.js";
import { resolvePaseoWsTarget } from "./paseo-endpoint.js";
import { dispatchPaseoPrompt } from "./prompt-dispatch.js";
import { remoteUserContent } from "./remote-user-content.js";
import { coordinateMirroredSelect } from "./mirrored-select.js";
import { createProviderReconnectLoop } from "./provider-reconnect.js";
import { unknownRpcCommandError } from "./rpc-compat.js";
import { buildSessionStats } from "./session-stats.js";
import {
  bridgeCommandEntries, HEADLESS_HANDLED_COMMANDS, KNOWN_PI_BUILTINS, loadPiBuiltinNames, routePaseoCommand, type BridgeHandledCommand,
} from "./builtin-commands.js";
import { liveHeadlessOwner, sessionChangedOnDisk } from "./session-takeover.js";
import {
  assistantText, formatModelList, formatResumeList, formatSessionInfo, modelReference, parsePathArgument,
  parseThinkingLevel, pickResumeTarget, resolveModelArgument, serializeBranchJsonl, SIDE_QUESTION_SYSTEM_PROMPT,
  sideQuestionContext, sideQuestionPrompt, THINKING_LEVELS,
} from "./paseo-commands.js";
import { compactWithResult } from "./compaction-command.js";
import { projectedUserCaptures, readTextContent } from "./session-projection.js";
import { createPaseoWsConnection } from "./paseo-ws.js";
import { applyRemoteModel } from "./model-sync.js";
import { normalizePiEventForPaseo } from "./tool-result-normalization.js";
import { TurnVisibilityProjection } from "./turn-visibility.js";
import { paseoVersionWarning, piVersionWarning, runningPiVersion, warnOnce } from "./version-support.js";
import { bridgeSettingsFile, environmentBoolean, isAutoEnabled, isImportEnabled, writeBridgeSettings, writeMutableJson } from "./bridge-settings.js";

type NotifyType = "info" | "warning" | "error";

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
// Session replacement needs Pi's command context: the bridge re-enters its own
// command with this subcommand and an encoded request.
const SESSION_SWITCH_SUBCOMMAND = "session-switch";

const BRIDGE_USAGE = "Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | takeover | status";
// Pi runs under the provider shim, which turns the extension's frames into Paseo RPC events.
const UNDER_SHIM = process.env[SHIM_PROTOCOL_ENV] === "1";
const DEBUG = environmentBoolean("PI_PASEO_BRIDGE_DEBUG", false);
const FORWARD_NOTIFICATIONS = environmentBoolean("PI_PASEO_BRIDGE_NOTIFICATIONS", true);
// Paseo fails a prompt that gets no answer within 30 seconds.
const STOPPED_TURN_WAIT_MS = 20_000;
const STOPPED_TURN_SETTLE_GRACE_MS = 1000;
const debugLogFile = path.join(bridgeStateDirectory(), "debug.log");

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

function readPaseoConfig(): Record<string, any> | null {
  // Throws on unreadable JSON so a file we could not parse is never replaced.
  return fs.existsSync(paseoConfigPath) ? JSON.parse(fs.readFileSync(paseoConfigPath, "utf8")) : null;
}

function installShimIntoPaseoConfig(): { ok: boolean; message: string } {
  const config = readPaseoConfig() ?? {};
  const result = addShimToPaseoConfig(config, [process.execPath, bridgeShimPath()].map(part => part.replaceAll("\\", "/")));
  if (result === "already-installed") return { ok: true, message: "Paseo shim already installed" };
  if (result === "conflict") {
    return {
      ok: false,
      message: `Paseo config already overrides the pi provider command (${JSON.stringify(config.agents.providers.pi.command)}). Remove agents.providers.pi.command from ${paseoConfigPath} first.`,
    };
  }
  writeMutableJson(paseoConfigPath, config);
  return { ok: true, message: "Paseo shim installed. Restart the Paseo daemon to apply: paseo restart" };
}

function uninstallShimFromPaseoConfig(): { ok: boolean; message: string } {
  const config = readPaseoConfig();
  const result = removeShimFromPaseoConfig(config);
  if (result === "not-installed") return { ok: true, message: "Paseo shim was not installed" };
  if (result === "conflict") {
    return {
      ok: false,
      message: `Leaving Paseo config untouched - the pi provider command is not the bridge shim: ${JSON.stringify(config!.agents.providers.pi.command)}`,
    };
  }
  writeMutableJson(paseoConfigPath, config!);
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

function paseoHostArgs(): string[] {
  return process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
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
  if (!environmentBoolean("PI_PASEO_BRIDGE")) return;

  let transport: BridgeTransport | null = null;
  let currentSessionFile: string | null = null;
  // Version reported by the Paseo daemon at the last WebSocket admission.
  let lastPaseoVersion: string | undefined;
  let reloadRequested = false;
  let reloadExecuting = false;
  let commandsInFlight = 0;
  const pendingCommandReplies = new Map<symbol, (reason: string) => void>();
  let lifecycleClosed = false;
  let lifecycleAbortController = new AbortController();
  let latestCtx: ExtensionContext | null = null;
  let restoreTerminalUi: (() => void) | undefined;
  // The terminal's own notify, bypassing forwarding to Paseo.
  let terminalNotify: ((message: string, type?: NotifyType) => void) | undefined;
  let isCompacting = false;
  // The extension API cannot change Pi's auto-compaction setting. Paseo's
  // /autocompact off instead cancels threshold compactions of this session;
  // overflow recovery still compacts so the retried turn can succeed.
  let autoCompactionSuppressed = false;
  let piBuiltins: ReadonlySet<string> = new Set<string>(KNOWN_PI_BUILTINS);
  void loadPiBuiltinNames().then(names => { piBuiltins = names; }, () => {});
  // A Paseo /btw side question in flight; Stop cancels it, not Pi's own turn.
  let sideQuestion: { controller: AbortController; requestId: unknown } | null = null;
  // A turn Paseo stopped before Pi finished stopping it. Paseo has already
  // ended that turn, so its remaining events are not forwarded, and the next
  // Paseo prompt waits until Pi has settled it.
  let stoppedTurn: { done: Promise<void>; finish(): void } | null = null;
  // A side question asked in a Paseo chat that Pi runs in the background.
  let headlessSideQuestion: AbortController | null = null;
  // Taking a session over from a Pi that Paseo runs in the background. Until it
  // is released, this terminal must not write the session.
  let takeover: { file: string; socket: net.Socket; released: boolean } | null = null;
  let takeoverBlockedFile: string | null = null;
  let takeoverPendingInput: string | undefined;
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

  async function reloadCurrentPaseoProvider(): Promise<void> {
    if (remoteUiConnected()) return;
    const agentId = currentAgentId;
    if (!agentId) throw new Error("Paseo agent ID is unavailable");
    const conn = openPaseoWs(IMPORT_TIMEOUT_MS);
    if (conn) {
      try {
        if (!await reusePaseoAgent(conn, agentId, () => currentAgentId === agentId && !remoteUiConnected())) {
          throw new Error(`Paseo agent is missing or archived: ${agentId}`);
        }
        debugLog("paseo provider reattach reload exited 0 (WebSocket)");
        return;
      } finally {
        conn.close();
      }
    }
    const cli = resolvePaseoCli();
    if (!cli) throw new Error("paseo CLI is unavailable for this host");
    return new Promise((resolve, reject) => {
      runPaseoCli(cli, ["agent", "reload", agentId, "--json", ...paseoHostArgs()], (code, output) => {
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
    const original = { select: ui.select, input: ui.input, confirm: ui.confirm, notify: ui.notify };

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
    // Other extensions' notifications also reach Paseo while it is attached.
    const notify: typeof ui.notify = (message, type) => {
      if (FORWARD_NOTIFICATIONS && remoteUiConnected() && typeof message === "string" && message.trim()) {
        send(notifyFrame(message, type ?? "info"));
      }
      return original.notify.call(ui, message, type);
    };
    ui.select = select;
    ui.input = input;
    ui.confirm = confirm;
    ui.notify = notify;
    terminalNotify = (message, type) => original.notify.call(ui, message, type);
    restoreTerminalUi = () => {
      if (ui.select === select) ui.select = original.select;
      if (ui.input === input) ui.input = original.input;
      if (ui.confirm === confirm) ui.confirm = original.confirm;
      if (ui.notify === notify) ui.notify = original.notify;
      terminalNotify = undefined;
    };
  }

  // Opens a connection to the Paseo daemon's WS API (hello handshake, then
  // session-wrapped request/response correlated by requestId). Used for
  // state the daemon only accepts as client requests (it caches
  // model/thinking/titles and prefers the cache over anything visible
  // through the provider RPC surface).
  function openPaseoWs(timeoutMs?: number): {
    request: (build: (requestId: string) => Record<string, unknown>) => Promise<any>;
    requestWithId: (requestId: string, message: Record<string, unknown>) => Promise<any>;
    close: () => void;
  } | null {
    // Relay/pairing URLs and SSH targets are reachable only
    // through the CLI; imports then land in the folder workspace.
    const target = resolvePaseoWsTarget();
    if (!target) return null;
    const { url, socketPath, localCredential } = target;
    // The local daemon's credential admits the bridge without a configured
    // password, as it does Paseo's own CLI. Otherwise PASEO_PASSWORD goes in
    // the hello and, for hosts predating hello auth, the bearer subprotocol.
    const password = localCredential ? null : readPaseoPassword();
    const protocols = password ? [`paseo.bearer.${password}`] : undefined;
    const ws = new WebSocket(url, protocols, socketPath
      ? { createConnection: () => net.createConnection(socketPath) }
      : undefined);
    debugLog(`paseo sync websocket connecting to ${socketPath ?? url}`);
    return createPaseoWsConnection(ws, {
      type: "hello",
      clientId: `pi-paseo-bridge-${process.pid}`,
      clientType: "cli",
      protocolVersion: 1,
      ...(localCredential
        ? { auth: { kind: "localCredential", token: localCredential } }
        : password ? { auth: { kind: "password", password } } : {}),
      // Stock Paseo sends direct permission acknowledgements only to sources
      // declaring owned subscriptions. No observation subscription is needed.
      capabilities: { owned_subscriptions: true, all_providers: true },
    }, {
      log: debugLog,
      ...(timeoutMs ? { timeoutMs } : {}),
      onServerInfo: (info) => {
        lastPaseoVersion = typeof info.version === "string" ? info.version : undefined;
        warnOnce(paseoVersionWarning(lastPaseoVersion), (message) => {
          debugLog(message);
          notifyTui(message, "warning");
        });
      },
    });
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

  function pushAgentConfigToPaseo(kind: "model" | "thinking", value: string | null, agentId = currentAgentId): void {
    if (!agentId) return;
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

  function notifyTui(message: string, notifyType: NotifyType = "info"): void {
    if (latestCtx?.mode !== "tui") return;
    try {
      (terminalNotify ?? latestCtx.ui.notify.bind(latestCtx.ui))(message, notifyType);
    } catch (err) {
      debugLog(`notifyTui failed: ${String(err)}`);
    }
  }

  function notifyFrame(message: string, notifyType: NotifyType = "info") {
    return { type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType };
  }

  function notifyEvent(message: string): void {
    send(notifyFrame(message));
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
      autoCompactionEnabled: autoCompactionEnabled(),
      bridgeCapabilities: { supportsRewindConversation: false, supportsAutoCompactionControl: true },
      messageCount,
      pendingMessageCount: ctx?.hasPendingMessages() ? 1 : 0,
      contextUsage: ctx?.getContextUsage(),
    };
  }

  function commandNotices(reply: (frame: unknown) => void) {
    return (message: string, notifyType: NotifyType) => reply(notifyFrame(message, notifyType));
  }


  function nativeAutoCompactionEnabled(): boolean {
    try {
      const enabled = (pi as any).getSettings?.()?.compaction?.enabled;
      return typeof enabled === "boolean" ? enabled : true;
    } catch {
      return true;
    }
  }

  function autoCompactionEnabled(): boolean {
    return nativeAutoCompactionEnabled() && !autoCompactionSuppressed;
  }

  /** Run a Pi built-in for Paseo. Output goes to Paseo's chat, never into Pi's session. */
  async function runPaseoBuiltin(name: BridgeHandledCommand, args: string, cmd: any, reply: (frame: unknown) => void): Promise<void> {
    const ctx = latestCtx;
    if (!ctx) throw new Error("Pi session is not ready.");
    const output = (text: string) => reply({ type: "command_output", text });
    switch (name) {
      case "btw":
        await askSideQuestion(ctx, args, cmd, reply);
        return;
      case "new":
      case "resume":
      case "clone":
        await requestSessionSwitch(name, args, ctx, output);
        break;
      default:
        await runSessionBuiltin(name, args, ctx, output);
    }
    reply(success(cmd.id, "prompt", { agentInvoked: false }));
  }

  /** Built-ins that read or change only the current session, in any Pi mode. */
  async function runSessionBuiltin(name: BridgeHandledCommand, args: string, ctx: ExtensionContext, output: (text: string) => void): Promise<void> {
    switch (name) {
      case "name": {
        if (!args) {
          const current = pi.getSessionName();
          output(current ? `Session name: ${current}` : "This session has no name. Set one with /name <name>.");
          break;
        }
        pi.setSessionName(args);
        output(`Session name set: ${pi.getSessionName() ?? args}`);
        break;
      }
      case "model": {
        const available = ctx.modelRegistry.getAvailable();
        if (!args) {
          output(formatModelList(available, ctx.model));
          break;
        }
        const model = resolveModelArgument(args, available);
        if (typeof model === "string") throw new Error(model);
        if (!await pi.setModel(model)) throw new Error(`No API key available for ${modelReference(model)}`);
        output(`Model set to ${modelReference(model)}.`);
        break;
      }
      case "thinking": {
        if (!args) {
          output(`Thinking level: ${pi.getThinkingLevel()}. Set it with /thinking <${THINKING_LEVELS.join("|")}>.`);
          break;
        }
        const level = parseThinkingLevel(args);
        if (!level) throw new Error(`Unknown thinking level "${args}". Use one of: ${THINKING_LEVELS.join(", ")}.`);
        pi.setThinkingLevel(level as any);
        const applied = pi.getThinkingLevel();
        output(applied === level ? `Thinking level set to ${applied}.` : `Thinking level set to ${applied}; ${modelReference(ctx.model)} does not support ${level}.`);
        break;
      }
      case "session":
        output(formatSessionInfo(buildSessionStats(ctx) as any, {
          name: pi.getSessionName(), model: ctx.model, thinking: pi.getThinkingLevel(),
        }));
        break;
      case "export":
        output(`Session exported to: ${await exportSession(ctx, parsePathArgument(args))}`);
        break;
      default:
        throw new Error(`/${name} is not available here.`);
    }
  }

  async function exportSession(ctx: ExtensionContext, requested: string | undefined): Promise<string> {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile();
    if (!sessionFile || !sessionFileSaved(sessionFile)) throw new Error("Nothing to export yet: Pi has not saved this session.");
    if (requested?.endsWith(".jsonl")) {
      const target = path.resolve(ctx.cwd, requested);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const header: any = sm.getHeader?.() ?? {};
      fs.writeFileSync(target, serializeBranchJsonl(
        { version: header.version, id: sm.getSessionId(), cwd: header.cwd ?? ctx.cwd },
        sm.getBranch() as any,
      ));
      return target;
    }
    // HTML rendering is not in the extension API; Pi's own CLI renders it.
    // A JavaScript runtime runs Pi's CLI script; a compiled Pi is its own executable.
    const entry = process.argv[1];
    const runtime = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i.test(path.basename(process.execPath));
    const script = runtime && entry && fs.existsSync(entry) ? [entry] : [];
    const outputArgs = requested ? [path.resolve(ctx.cwd, requested)] : [];
    const result = await pi.exec(process.execPath, [...script, "--export", sessionFile, ...outputArgs], { cwd: ctx.cwd, timeout: 60_000 } as any);
    if (result.code !== 0) throw new Error(`Export failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 500)}`);
    const reported = /(?:exported to|written to|saved to):?\s*(.+)$/im.exec(result.stdout)?.[1]?.trim();
    return outputArgs[0] ?? reported ?? result.stdout.trim();
  }

  /**
   * Answer `/btw <question>` from the session's context without adding either
   * to Pi's session. The prompt is acknowledged at once and completes through
   * prompt_result, so a slow answer does not hit Paseo's RPC timeout.
   */
  async function askSideQuestion(ctx: ExtensionContext, question: string, cmd: any, reply: (frame: unknown) => void): Promise<void> {
    if (!question) throw new Error("Usage: /btw <question>");
    if (sideQuestion) throw new Error("A side question is already running. Wait for its answer or press Stop.");
    const model = ctx.model;
    if (!model) throw new Error("No model is selected.");
    const controller = new AbortController();
    const current = { controller, requestId: cmd.id };
    sideQuestion = current;
    // Frames after the reply belong to the same controller connection only.
    const owner = transport;
    const epoch = owner?.connectionEpoch;
    const later = (frame: unknown) => {
      if (owner && owner === transport && owner.connected && owner.connectionEpoch === epoch) owner.send(frame);
    };
    reply(success(cmd.id, "prompt", { agentInvoked: true }));
    const result = await answerSideQuestion(ctx, model, question, controller.signal);
    if (sideQuestion === current) sideQuestion = null;
    if ("text" in result) later({ type: "command_output", text: result.text });
    else later(notifyFrame(result.error, "error"));
    later({ type: "prompt_result", id: cmd.id, agentInvoked: false });
  }

  /** The side question's answer, never added to Pi's session. */
  async function answerSideQuestion(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, question: string, signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }> {
    const finish = (text: string | undefined, error?: string) => text !== undefined ? { text } : { error: error ?? "Side question failed." };
    try {
      const context = {
        systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
        messages: [{
          role: "user" as const,
          content: [{ type: "text" as const, text: sideQuestionPrompt(question, sideQuestionContext(ctx.sessionManager.getBranch() as any)) }],
          timestamp: Date.now(),
        }],
      };
      const level = pi.getThinkingLevel();
      const options: Record<string, unknown> = { signal: signal, sessionId: crypto.randomUUID() };
      if (level && level !== "off") options.reasoning = level;
      const registry: any = ctx.modelRegistry;
      let answer: any;
      if (typeof registry.streamSimple === "function") {
        answer = await registry.streamSimple(model, context, options).result();
      } else {
        const auth = typeof registry.getApiKeyAndHeaders === "function"
          ? await registry.getApiKeyAndHeaders(model)
          : { apiKey: await registry.getApiKey?.(model) };
        const { completeSimple } = await import("@earendil-works/pi-ai") as any;
        answer = await completeSimple(model, context, { ...options, apiKey: auth?.apiKey, headers: auth?.headers });
      }
      if (signal.aborted || answer?.stopReason === "aborted") return finish(undefined, "Side question cancelled.");
      if (answer?.stopReason === "error") return finish(undefined, `Side question failed: ${answer.errorMessage ?? "model error"}`);
      return finish(`btw: ${question}\n\n${assistantText(answer) || "(no answer)"}`);
    } catch (error) {
      return finish(undefined, signal.aborted ? "Side question cancelled." : `Side question failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function requestSessionSwitch(
    kind: "new" | "resume" | "clone", args: string, ctx: ExtensionContext, output: (text: string) => void,
  ): Promise<void> {
    if (!ctx.isIdle() || ctx.hasPendingMessages() || isCompacting) throw new Error(`Pi must be idle for /${kind}. Wait for the current turn or press Stop.`);
    let request: Record<string, unknown>;
    if (kind === "new") {
      if (!args) throw new Error("Usage: /new <first prompt>. Paseo shows the new session once Pi saves its first reply.");
      request = { kind, prompt: args };
      output("Starting a new Pi session in the terminal. It appears in Paseo as a new chat after its first reply; this chat stops following the terminal.");
    } else if (kind === "resume") {
      const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir?.());
      sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
      const recent = sessions.slice(0, 20);
      if (!args) {
        output(formatResumeList(recent, ctx.sessionManager.getSessionFile()));
        return;
      }
      const target = pickResumeTarget(args, sessions);
      if (typeof target === "string") throw new Error(target);
      if (target.path === ctx.sessionManager.getSessionFile()) {
        output("The terminal is already in that session.");
        return;
      }
      request = { kind, path: target.path };
      output(`Switching the terminal to "${(target.name || target.firstMessage).slice(0, 70)}". Paseo shows it as its own chat; this chat stops following the terminal.`);
    } else {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) throw new Error("Nothing to clone yet.");
      request = { kind, leafId };
      output("Cloning this session in the terminal. Paseo shows the copy as a new chat; this chat stops following the terminal.");
    }
    const payload = Buffer.from(JSON.stringify(request)).toString("base64url");
    // Run after Paseo has the reply: the switch closes this chat's connection.
    setTimeout(() => {
      try { pi.sendUserMessage(`/paseo-bridge ${SESSION_SWITCH_SUBCOMMAND} ${payload}`, { expandPromptTemplates: true }); }
      catch (error) { notifyEvent(`Pi session switch failed: ${String(error).slice(0, 500)}`); }
    }, 50);
  }

  async function runSessionSwitch(raw: string, ctx: ExtensionCommandContext): Promise<void> {
    const request = decodeCommandPayload(raw);
    const fail = (message: string) => {
      notifyEvent(message);
      notifyTui(message, "error");
    };
    try {
      let result: { cancelled: boolean } | undefined;
      if (request?.kind === "new" && typeof request.prompt === "string") {
        const prompt = request.prompt;
        result = await ctx.newSession({ withSession: async next => { await next.sendUserMessage(prompt); } });
      } else if (request?.kind === "resume" && typeof request.path === "string") {
        const prompt = typeof request.prompt === "string" ? request.prompt : undefined;
        result = await ctx.switchSession(request.path, prompt
          ? { withSession: async next => { await next.sendUserMessage(prompt); } }
          : undefined);
      } else if (request?.kind === "clone" && typeof request.leafId === "string") {
        result = await ctx.fork(request.leafId, { position: "at" });
      } else {
        throw new Error("Invalid session switch request.");
      }
      if (result?.cancelled) fail("The Pi session switch was cancelled.");
    } catch (error) {
      fail(`Pi session switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  // ------------------------------------------------------------------
  // Pi that Paseo runs in the background (RPC mode). Pi runs its interactive
  // built-ins only in a terminal; sent from Paseo they would reach the model.
  // The bridge answers them from an input handler. Under the provider shim,
  // frames become Paseo's own command output and prompt results.

  function shimFrame(ctx: ExtensionContext, frame: Record<string, unknown>): void {
    ctx.ui.notify(`${FRAME_MARKER} ${JSON.stringify(frame)}`, "info");
  }

  function headlessOutput(ctx: ExtensionContext, text: string): void {
    if (UNDER_SHIM) shimFrame(ctx, { op: "output", text });
    else ctx.ui.notify(text, "info");
  }

  /** Fail the Paseo prompt `message` with `error`. */
  function headlessFailure(ctx: ExtensionContext, message: string, error: string): void {
    if (UNDER_SHIM) shimFrame(ctx, { op: "fail", message, error });
    else ctx.ui.notify(error, "error");
  }

  function announceHeadlessCommands(ctx: ExtensionContext): void {
    if (!UNDER_SHIM) return;
    shimFrame(ctx, {
      op: "commands",
      commands: HEADLESS_HANDLED_COMMANDS.map(({ name, description }) => ({ name, description })),
      capabilities: { autocompact: true },
    });
  }

  /** Mirror a change made by a command into Paseo's cached agent state. */
  function syncHeadlessAgent(ctx: ExtensionContext, change: "model" | "thinking" | "name"): void {
    const agentId = process.env.PASEO_AGENT_ID?.trim();
    if (!agentId) return;
    if (change === "model") pushAgentConfigToPaseo("model", modelToId(ctx.model), agentId);
    else if (change === "thinking") pushAgentConfigToPaseo("thinking", pi.getThinkingLevel() ?? null, agentId);
    else {
      const name = pi.getSessionName();
      if (name) paseoSessionRequest(requestId => ({ type: "update_agent_request", agentId, name, requestId }), "session name");
    }
  }

  async function runHeadlessBuiltin(name: BridgeHandledCommand, args: string, message: string, ctx: ExtensionContext): Promise<void> {
    if (name !== "btw") {
      await runSessionBuiltin(name, args, ctx, text => headlessOutput(ctx, text));
      if (name === "model" || name === "thinking" || name === "name") {
        if (args) syncHeadlessAgent(ctx, name);
      }
      return;
    }
    if (!args) throw new Error("Usage: /btw <question>");
    if (headlessSideQuestion) throw new Error("A side question is already running. Wait for its answer or press Stop.");
    const model = ctx.model;
    if (!model) throw new Error("No model is selected.");
    const controller = new AbortController();
    headlessSideQuestion = controller;
    const answer = answerSideQuestion(ctx, model, args, controller.signal).then(result => {
      if (headlessSideQuestion === controller) headlessSideQuestion = null;
      if ("text" in result) headlessOutput(ctx, result.text);
      else ctx.ui.notify(result.error, "error");
    });
    if (!UNDER_SHIM) return answer;
    // Answer the prompt now and finish it once the answer arrives, so a slow
    // model does not hit Paseo's prompt deadline.
    shimFrame(ctx, { op: "defer", message });
    void answer.finally(() => shimFrame(ctx, { op: "done", message }));
  }

  pi.on("input", async (event, ctx) => {
    if (ctx.mode === "tui") {
      if (event.source !== "interactive" || !takeoverBlockedFile
        || takeoverBlockedFile !== ctx.sessionManager.getSessionFile()) return { action: "continue" };
      if (!event.images?.length) takeoverPendingInput = event.text;
      ctx.ui.notify(event.images?.length
        ? "Paseo still runs this session in the background. Send images once this terminal has taken it over."
        : "Paseo still runs this session in the background. Your message is sent once this terminal has taken it over; /paseo-bridge takeover stops Paseo's work now.",
      "warning");
      return { action: "handled" };
    }
    if (ctx.mode !== "rpc" || event.source !== "rpc") return { action: "continue" };
    const route = routePaseoCommand(event.text, pi.getCommands(), piBuiltins, { headless: true });
    if (route.kind === "pass") return { action: "continue" };
    if (route.kind === "reject") {
      headlessFailure(ctx, event.text, route.message);
      return { action: "handled" };
    }
    try {
      if (event.images?.length) throw new Error(`/${route.name} does not accept image attachments.`);
      await runHeadlessBuiltin(route.name, route.args, event.text, ctx);
    } catch (error) {
      headlessFailure(ctx, event.text, error instanceof Error ? error.message : String(error));
    }
    return { action: "handled" };
  });

  /** Shim requests in a background Pi: per-session auto-compaction and Stop for /btw. */
  function runHeadlessControl(subcommand: string, args: string[], ctx: ExtensionContext): void {
    if (subcommand === "headless-cancel") {
      headlessSideQuestion?.abort();
      return;
    }
    const [value, token] = args;
    const reply = (frame: Record<string, unknown>) => { if (UNDER_SHIM) shimFrame(ctx, { op: "reply", token, ...frame }); };
    const enabled = value === "on";
    if (enabled && !nativeAutoCompactionEnabled()) {
      reply({ ok: false, error: "Auto-compaction is off in Pi's settings. Turn it on with /settings in a terminal Pi." });
      return;
    }
    autoCompactionSuppressed = !enabled;
    if (UNDER_SHIM) shimFrame(ctx, { op: "autocompact", enabled });
    reply({ ok: true });
  }

  // ------------------------------------------------------------------
  // Taking a session over from a background Pi. A terminal resuming a
  // session Paseo runs asks the shim to stop its Pi once idle, then loads what
  // that Pi wrote and attaches to the same Paseo chat.

  function startTakeover(ctx: ExtensionContext, file: string, owner: { bridgeSocket: string }, force: boolean): void {
    takeoverBlockedFile = file;
    if (takeover?.file === file && !takeover.socket.destroyed) {
      if (force) takeover.socket.write(jsonLine({ type: "force" }));
      return;
    }
    takeover?.socket.destroy();
    const socket = net.connect(owner.bridgeSocket);
    const attempt = { file, socket, released: false };
    takeover = attempt;
    let lastWaiting: string | undefined;
    socket.once("connect", () => socket.write(jsonLine({ type: "takeover", force, pid: process.pid })));
    lineReader(socket, (_line: string, msg: any) => {
      if (takeover !== attempt) return;
      if (msg?.type === "waiting" && msg.reason !== lastWaiting) {
        lastWaiting = msg.reason;
        notifyTui(`Paseo is still using this session (${msg.reason}). This terminal takes it over when Pi there is idle; /paseo-bridge takeover stops that work now.`, "warning");
      } else if (msg?.type === "refused") {
        notifyTui(`Paseo refused the takeover: ${msg.reason}. Retry with /paseo-bridge takeover.`, "error");
      } else if (msg?.type === "released") {
        attempt.released = true;
        takeover = null;
        socket.end();
        completeTakeover(file, typeof msg.agentId === "string" ? msg.agentId : undefined);
      }
    });
    const failed = (error?: Error) => {
      if (attempt.released || takeover !== attempt) return;
      takeover = null;
      debugLog(`takeover failed: ${String(error ?? "closed")}`);
      if (liveHeadlessOwner(file)) {
        notifyTui("Could not take this session over from Paseo, which still runs it. Do not type here: retry with /paseo-bridge takeover, or quit this Pi.", "error");
      } else {
        takeoverBlockedFile = null;
        if (!lifecycleClosed && latestCtx?.sessionManager.getSessionFile() === file) connectSession(latestCtx);
      }
    };
    socket.once("error", failed);
    socket.once("close", () => failed());
  }

  function completeTakeover(file: string, agentId: string | undefined): void {
    const ctx = latestCtx;
    if (lifecycleClosed || !ctx || ctx.sessionManager.getSessionFile() !== file) return;
    if (agentId) writeAgentMapEntry(file, agentId);
    takeoverBlockedFile = null;
    const prompt = takeoverPendingInput;
    takeoverPendingInput = undefined;
    if (sessionChangedOnDisk(file, ctx.sessionManager.getEntries() as any)) {
      // Reopen the session so this Pi has what the background Pi wrote. The
      // reopened session attaches to the same Paseo chat when it starts.
      notifyTui("Took this session over from Paseo; loading its latest messages.");
      const payload = Buffer.from(JSON.stringify({ kind: "resume", path: file, ...(prompt ? { prompt } : {}) })).toString("base64url");
      setTimeout(() => {
        try { pi.sendUserMessage(`/paseo-bridge ${SESSION_SWITCH_SUBCOMMAND} ${payload}`, { expandPromptTemplates: true }); }
        catch (error) { notifyTui(`Could not reload the session: ${String(error)}. Run /resume and pick it again.`, "error"); }
      }, 0);
      return;
    }
    notifyTui("Took this session over from Paseo.");
    connectSession(ctx);
    if (prompt) pi.sendUserMessage(prompt);
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
    await waitForStoppedTurn();
    const route = routePaseoCommand(message, pi.getCommands(), piBuiltins);
    if (route.kind === "reject") throw new Error(route.message);
    if (route.kind === "bridge") {
      if (Array.isArray(cmd.images) && cmd.images.length) throw new Error(`/${route.name} does not accept image attachments.`);
      await runPaseoBuiltin(route.name, route.args, cmd, send);
      return;
    }
    const content = remoteUserContent(message, cmd.images);
    const streaming = latestCtx ? !latestCtx.isIdle() : false;
    const result = await dispatchPaseoPrompt(pi, content, message, streaming);
    send(success(cmd.id, "prompt", result));
  }

  /**
   * Paseo sends its replacement prompt as soon as Stop is acknowledged. Start it
   * only once Pi has stopped, so it begins a new turn instead of queueing behind
   * the stopped one, and fail it within Paseo's prompt deadline otherwise.
   */
  async function waitForStoppedTurn(): Promise<void> {
    const turn = stoppedTurn;
    if (!turn) return;
    if (await waitForSettlement(turn.done, STOPPED_TURN_WAIT_MS)) return;
    throw new Error("Pi is still stopping the previous turn: a running tool has not exited. Wait for it or press Escape in the Pi terminal, then send again.");
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
          const route = routePaseoCommand(cmd.message, pi.getCommands(), piBuiltins);
          if (route.kind === "reject") throw new Error(route.message);
          if (route.kind === "bridge") throw new Error(`/${route.name} must be sent as an ordinary prompt.`);
          const result = await dispatchPaseoPrompt(pi, remoteUserContent(cmd.message, cmd.images),
            cmd.message, false, type === "steer" ? "steer" : "followUp");
          send(success(id, type, result));
          return;
        }
        case "abort":
          if (sideQuestion) {
            // Paseo's Stop targets the side question it is waiting for.
            sideQuestion.controller.abort();
            send(success(id, type));
            return;
          }
          cancelPendingRemoteUiRequests();
          // Capture this lifecycle's context and signal. Never use ctx.signal:
          // that signal belongs to turn work, not the lifetime of this waiter.
          {
            const outcome = await abortAndAcknowledge(latestCtx, { signal: lifecycleAbortController.signal });
            if (!outcome.settled) {
              let finished!: () => void;
              const turn = {
                done: new Promise<void>(resolve => { finished = resolve; }),
                finish() {
                  if (stoppedTurn === turn) stoppedTurn = null;
                  finished();
                },
              };
              stoppedTurn = turn;
              // agent_settled normally ends it; the grace covers a Pi that skips that event.
              outcome.idle.then(() => setTimeout(() => turn.finish(), STOPPED_TURN_SETTLE_GRACE_MS), () => turn.finish());
              debugLog("abort acknowledged while Pi is still stopping");
              notifyEvent("Pi is still stopping the previous turn; a running tool has not exited yet.");
            }
          }
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
        case "get_commands": {
          const commands = pi.getCommands();
          // Paseo keeps the last entry of a name, so bridge entries go last.
          send(success(id, type, { commands: [...commands.filter(command => command.name !== "btw"), ...bridgeCommandEntries(commands)] }));
          return;
        }
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
        case "set_auto_compaction": {
          if (typeof cmd.enabled !== "boolean") throw new Error("enabled must be a boolean");
          if (cmd.enabled && !nativeAutoCompactionEnabled()) {
            throw new Error("Auto-compaction is off in Pi's settings. Turn it on with /settings in the terminal.");
          }
          autoCompactionSuppressed = !cmd.enabled;
          send(success(id, type));
          return;
        }
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

  const agentMapFile = path.join(bridgeStateDirectory(), "agents.json");
  // Imports can wait for Paseo to start the session's provider.
  const IMPORT_TIMEOUT_MS = 60_000;
  let workspaceAwaitingTitle: string | undefined;
  const PASEO_WS_UNREACHABLE = new Set([
    "Paseo hello rejected", "Paseo hello timeout", "Paseo connection error", "Paseo connection closed",
  ]);

  function writeRuntimeRecord(sessionFile: string, cwd: string): void {
    try {
      const runtimeRegistryDir = runtimeRegistryDirectory();
      fs.mkdirSync(runtimeRegistryDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(runtimeRegistryDir, 0o700);
      const destination = runtimeRecordFile(sessionFile);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 3,
        kind: "terminal",
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
      map[sessionKey(sessionFile)] = agentId;
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

  // Retries imports that failed or were throttled; started for every bridged session.
  function startImportRetries(): void {
    if (importTimer) return;
    importTimer = setInterval(() => {
      if (!lifecycleClosed && currentSessionFile && latestCtx && !currentAgentId) {
        registerWithPaseo(currentSessionFile, latestCtx.cwd);
      }
    }, 2000);
    importTimer.unref();
  }

  function stopImportRetries(): void {
    if (importTimer) clearInterval(importTimer);
    importTimer = undefined;
  }

  function registerWithPaseo(sessionFile: string, cwd: string): void {
    if (importAttempted.has(sessionFile) || lifecycleClosed || Date.now() < importRetryAt) return;
    // Pi writes a new session's file only once its conversation starts, and Paseo reads
    // that file on import. The import timer retries once the file exists.
    if (!sessionFileSaved(sessionFile)) return;
    const isCurrent = () => !lifecycleClosed && currentSessionFile === sessionFile;
    if (!isImportEnabled()) return;
    importAttempted.add(sessionFile);
    const cli = resolvePaseoCli();
    const knownAgentId = readAgentMap()[sessionKey(sessionFile)];
    const hostArgs = paseoHostArgs();
    const retryImport = () => {
      // Keep retries slow while the local daemon is unavailable.
      const delay = importRetryDelay(++importFailures) ?? 60_000;
      importRetryAt = Date.now() + delay;
      importAttempted.delete(sessionFile);
    };
    const runImport = () => {
      const conn = openPaseoWs(IMPORT_TIMEOUT_MS);
      if (!conn) {
        runCliRestore();
        return;
      }
      void (async () => {
        if (knownAgentId) {
          const reused = await reusePaseoAgent(conn, knownAgentId, () => isCurrent() && !remoteUiConnected());
          if (!isCurrent()) return undefined;
          if (reused) {
            return { agentId: knownAgentId, workspaceId: undefined, untitled: false, reused: true };
          }
        }
        const sm = latestCtx?.sessionManager;
        const title = sessionWorkspaceTitle(sm?.getSessionName(), firstUserPrompt(sm?.getEntries() ?? []));
        try {
          const result = await importIntoSessionWorkspace(
            conn,
            { sessionFile, cwd, workspaceId: sessionWorkspaceId(sessionKey(sessionFile)), ...(title ? { title } : {}) },
            (err) => debugLog(`session workspace unavailable; importing into the folder workspace: ${String(err)}`),
          );
          return { ...result, reused: false };
        } catch (error) {
          if (!String((error as Error)?.message ?? error).startsWith("Provider session is already imported:")) throw error;
          // The map is a local cache: another terminal may have overwritten it,
          // or import may have succeeded before its response was lost.
          const existingId = await findImportedPiAgent(conn, sessionFile);
          if (!isCurrent()) return undefined;
          if (!existingId) throw error;
          if (!await reusePaseoAgent(conn, existingId, () => isCurrent() && !remoteUiConnected())) throw error;
          return { agentId: existingId, workspaceId: undefined, untitled: false, reused: true };
        }
      })()
        .then((result) => {
          if (!result || !isCurrent()) return;
          debugLog(`paseo import placed ${result.agentId} in ${result.workspaceId ?? "the folder workspace"}`);
          workspaceAwaitingTitle = result.untitled ? result.workspaceId : undefined;
          writeAgentMapEntry(sessionFile, result.agentId);
          adoptAgent(result.agentId, result.reused);
        })
        .catch((err) => {
          if (!isCurrent()) return;
          const message = String(err?.message ?? err);
          debugLog(`paseo import failed: ${message}`);
          // A daemon that refuses this WebSocket client may still accept the CLI.
          if (PASEO_WS_UNREACHABLE.has(message)) runCliRestore();
          else retryImport();
        })
        .finally(() => conn.close());
    };
    // Relay hosts are reachable only through the CLI.
    const runCliImport = () => {
      if (!cli) {
        debugLog("paseo CLI not found for this host; retrying (set PASEO_CLI for relay/SSH)");
        retryImport();
        return;
      }
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
          if (jsonStart === -1) throw new Error("import returned no JSON result");
          const result = JSON.parse(output.slice(jsonStart));
          if (typeof result.agentId === "string" && result.agentId) {
            writeAgentMapEntry(sessionFile, result.agentId);
            adoptAgent(result.agentId, false);
          } else {
            throw new Error("import returned no agent ID");
          }
        } catch (err) {
          debugLog(`could not parse import output: ${String(err)}`);
          retryImport();
        }
      });
    };
    const runCliRestore = () => {
      if (!knownAgentId || !cli) {
        runCliImport();
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
          runCliImport();
          return;
        }
        if (remoteUiConnected()) {
          adoptAgent(knownAgentId, true);
          return;
        }
        // Only a disconnected controller needs a reload: refreshing a live
        // provider would interrupt its active turn.
        runPaseoCli(cli, ["agent", "reload", knownAgentId, "--json", ...hostArgs], (reloadCode, reloadOutput) => {
          if (!isCurrent()) return;
          debugLog(`paseo agent reload exited ${reloadCode}: ${reloadOutput.slice(0, 200)}`);
          if (reloadCode === 0) adoptAgent(knownAgentId, true);
          else retryImport();
        });
      });
    };
    runImport();
  }

  function connectSession(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return "This session is ephemeral (--no-session); nothing to bridge.";
    warnOnce(piVersionWarning(), (message) => {
      debugLog(message);
      notifyTui(message, "warning");
    });
    const background = liveHeadlessOwner(file);
    if (background) {
      if (file !== currentSessionFile) stopServer();
      startTakeover(ctx, file, background, false);
      return "This session is open in Paseo; this terminal takes it over once Pi there is idle...";
    }
    if (file !== currentSessionFile) {
      workspaceAwaitingTitle = undefined;
      stopServer();
      startServer(file);
    }
    writeRuntimeRecord(file, ctx.cwd);
    importAttempted.delete(file);
    importFailures = 0;
    importRetryAt = 0;
    startImportRetries();
    registerWithPaseo(file, ctx.cwd);
    return sessionFileSaved(file)
      ? "Connecting session to Paseo..."
      : "Connecting session to Paseo once Pi saves its first message...";
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
      const force = environmentBoolean("PI_PASEO_BRIDGE_FORCE", false);
      if (ctx.mode !== "tui" && !force) {
        retained?.transport.close();
        if (ctx.mode === "rpc") announceHeadlessCommands(ctx);
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
        } else {
          startImportRetries();
          registerWithPaseo(currentSessionFile, ctx.cwd);
        }
      } else {
        // A session Paseo runs in the background must be taken over before
        // this terminal writes it, even without auto-connect.
        const file = ctx.sessionManager.getSessionFile();
        if (!isAutoEnabled() && !(file && liveHeadlessOwner(file))) return;
        connectSession(ctx);
      }
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
    takeover?.socket.destroy();
    takeover = null;
    takeoverBlockedFile = null;
    headlessSideQuestion?.abort();
    restoreTerminalUi?.();
    restoreTerminalUi = undefined;
    lifecycleAbortController.abort();
    latestCtx = null;
    stopImportRetries();
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
      const visible = turnVisibility.project(normalized as Record<string, any>);
      if (stoppedTurn) {
        // Paseo has already ended this turn; its late events would end the next one.
        if (eventName === "agent_settled") stoppedTurn.finish();
        return;
      }
      for (const frame of visible) send(frame);
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
    // Only this session's own workspace has this ID; a folder workspace is left alone.
    const title = sessionWorkspaceTitle(name);
    if (currentSessionFile && title) {
      workspaceAwaitingTitle = undefined;
      paseoSessionRequest(workspaceTitleRequest(sessionWorkspaceId(sessionKey(currentSessionFile)), title), "workspace title");
    }
  }

  // A session imported before its first prompt names its workspace after that prompt.
  function titleWorkspaceFromPrompt(ctx: ExtensionContext): void {
    const workspaceId = workspaceAwaitingTitle;
    if (!workspaceId || !currentAgentId) return;
    const title = sessionWorkspaceTitle(ctx.sessionManager.getSessionName(), firstUserPrompt(ctx.sessionManager.getEntries()));
    if (!title) return;
    workspaceAwaitingTitle = undefined;
    paseoSessionRequest(workspaceTitleRequest(workspaceId, title), "workspace title");
  }

  pi.on("session_info_changed", (_event, ctx) => syncSessionName(ctx));

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    if (!stoppedTurn) send(event);
    emitSubmittedUserEntries(ctx);
    emitEntryCapture(ctx, "turn_end");
    titleWorkspaceFromPrompt(ctx);
  });

  let suppressedCompaction = false;
  pi.on("session_before_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    if (autoCompactionSuppressed && event?.reason === "threshold") {
      suppressedCompaction = true;
      return { cancel: true };
    }
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
    if (suppressedCompaction) {
      suppressedCompaction = false;
      return;
    }
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
      connection?.send(notifyFrame(`Pi runtime reload failed: ${String(error).slice(0, 2000)}`, "error"));
      throw error;
    }
  };
  pi.registerCommand("remote-reload", {
    description: "Reload Pi extensions and resources while idle, without restarting Pi or cancelling background jobs",
    handler: reloadRuntime,
  });

  function versionNote(warning: string | undefined): string {
    return warning ? ` (${warning.includes("older") ? "older than supported" : "untested; continuing tentatively"})` : "";
  }

  function bridgeStatus(): string {
    let shimInstalled = false;
    try {
      shimInstalled = isOurShimCommand(readPaseoConfig()?.agents?.providers?.pi?.command);
    } catch {
      // unreadable config counts as not installed
    }
    const cli = resolvePaseoCli();
    const session = takeover
      ? "taking over from the Pi that Paseo runs in the background"
      : transport
        ? currentAgentId ? `bridged as Paseo agent ${currentAgentId}` : "bridged (not yet imported)"
        : "not bridged";
    return [
      "Paseo bridge status",
      `shim: ${shimInstalled ? "installed" : "not installed (run /paseo-bridge install)"}`,
      `paseo CLI: ${cli ?? "not found (optional for local TCP/socket connections; set PASEO_CLI for relay/SSH)"}`,
      `auto-connect: ${isAutoEnabled() ? "on" : "off"}`,
      `settings: ${bridgeSettingsFile()}`,
      `session import: ${isImportEnabled() ? "on" : "off"}`,
      `session: ${session}`,
      `Pi: ${runningPiVersion() ?? "unknown"}${versionNote(piVersionWarning())}`,
      `Paseo: ${lastPaseoVersion ? `${lastPaseoVersion}${versionNote(paseoVersionWarning(lastPaseoVersion))}` : "not yet contacted"}`,
    ].join("\n");
  }

  async function runBridgeManagement(args: string, ctx: ExtensionContext, reportFailure = false,
    notify: (message: string, type: NotifyType) => void = (message, type) => ctx.ui.notify(message, type),
  ): Promise<void> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const reportResult = (result: { ok: boolean; message: string }) => {
      if (reportFailure && !result.ok) throw new Error(result.message);
      notify(result.message, result.ok ? "info" : "error");
    };
    try {
      switch (parts[0] ?? "status") {
        case "install":
          notify(RPIV_INCOMPATIBILITY_WARNING, "warning");
          reportResult(installShimIntoPaseoConfig());
          return;
        case "uninstall":
          reportResult(uninstallShimFromPaseoConfig());
          return;
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
        case "takeover": {
          const file = ctx.sessionManager.getSessionFile();
          const background = file ? liveHeadlessOwner(file) : undefined;
          if (!file || !background) {
            notify("Paseo does not run this session in the background; nothing to take over.", "info");
            return;
          }
          startTakeover(ctx, file, background, true);
          notify("Stopping Paseo's work in this session and taking it over...", "info");
          return;
        }
        case "status":
          notify(bridgeStatus(), "info");
          return;
        default:
          if (reportFailure) throw new Error(BRIDGE_USAGE);
          notify(BRIDGE_USAGE, "warning");
      }
    } catch (err) {
      if (reportFailure) throw err;
      notify(`paseo-bridge: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  pi.registerCommand("paseo-bridge", {
    description: `Manage the Paseo bridge: ${BRIDGE_USAGE.slice("Usage: /paseo-bridge ".length)}`,
    handler: (args, ctx) => {
      const [subcommand, payload = ""] = args.trim().split(/\s+/, 2);
      if (subcommand === SESSION_SWITCH_SUBCOMMAND) return runSessionSwitch(payload, ctx);
      if (ctx.mode === "rpc" && (subcommand === "headless-autocompact" || subcommand === "headless-cancel")) {
        runHeadlessControl(subcommand, args.trim().split(/\s+/).slice(1), ctx);
        return Promise.resolve();
      }
      return runBridgeManagement(args, ctx);
    },
  });
}
