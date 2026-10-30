import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(process.env.BRIDGE_PI_SDK);

const sessionFile = process.env.DIALOG_SESSION_FILE;
const receipt = value => appendFileSync(process.env.DIALOG_RECEIPT_FILE, JSON.stringify(value) + "\n");
const fixture = pi => {
  pi.registerProvider("bridge-offline", {
    api: "bridge-offline-never-stream", baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture-not-a-secret",
    streamSimple() { throw new Error("Dialog fixture must not call a model"); },
    models: [{id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 32768, maxTokens: 1024}],
  });
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "startup") {
      const value = await ctx.ui.select("Disconnected fixture", ["One"]);
      receipt({key: "disconnected", method: "select", value});
    }
    writeFileSync(process.env.DIALOG_READY_FILE, event.reason);
  });
  pi.registerCommand("stock-dialog", {description: "Ordinary stock Pi UI fixture", handler: async (args, ctx) => {
    const [method, key] = args.trim().split(" ");
    const aborter = new AbortController();
    const cancellation = method === "abort" ? setInterval(() => {
      if (existsSync(process.env.DIALOG_RELEASE_FILE)) aborter.abort();
    }, 5) : undefined;
    try {
      const value = method === "confirm" ? await ctx.ui.confirm("Confirm fixture", "Continue?")
        : method === "input" ? await ctx.ui.input("Input fixture", "Literal response")
        : method === "abort" ? await ctx.ui.input("Abort fixture", "Literal response", {signal: aborter.signal})
        : await ctx.ui.select("Choose fixture", ["One", "Two"], method === "timeout" ? {timeout: 1000} : undefined);
      receipt({key, method, value: value ?? null});
    } finally { if (cancellation) clearInterval(cancellation); }
  }});
};

const loader = new DefaultResourceLoader({cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
  additionalExtensionPaths: [process.env.BRIDGE_NATIVE_EXTENSION], extensionFactories: [fixture],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
await loader.reload();
if (!existsSync(sessionFile)) writeFileSync(sessionFile, "");
const {session} = await createAgentSession({cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
  resourceLoader: loader, sessionManager: SessionManager.open(sessionFile, undefined, process.cwd()), noTools: "all"});

// The SDK owns the real extension runner. This controlled UI replaces only the
// terminal renderer, so standard ctx.ui calls can race genuine Paseo decisions.
function localDialog(title, _options, settings) {
  if (title === "Disconnected fixture") return Promise.resolve("One");
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearInterval(poll); clearTimeout(timeout);
      settings?.signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    const aborted = () => finish(undefined);
    const poll = setInterval(() => { if (existsSync(process.env.DIALOG_RELEASE_FILE)) finish("One"); }, 5);
    const timeout = settings?.timeout ? setTimeout(aborted, settings.timeout) : undefined;
    settings?.signal?.addEventListener("abort", aborted, {once: true});
    if (settings?.signal?.aborted) aborted();
  });
}
const ui = {select: localDialog, input: localDialog,
  confirm: async (title, message, settings) => (await localDialog(title, ["Yes", "No"], settings)) === "Yes",
  notify() {}};
await session.bindExtensions({mode: "tui", uiContext: ui});
const reply = (id, data) => process.stdout.write(JSON.stringify({id, type: "response", success: true, data}) + "\n");
const lines = readline.createInterface({input: process.stdin});
lines.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "get_state") { reply(command.id, {}); return; }
  if (command.type === "reload") { void session.reload().then(() => reply(command.id)); return; }
  void session.prompt(command.message, {expandPromptTemplates: true}).then(() => reply(command.id), error => {
    process.stdout.write(JSON.stringify({id: command.id, type: "response", success: false, error: String(error)}) + "\n");
  });
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await session.abort();
  session.dispose();
  process.exit(0);
}
lines.on("close", () => void close());
process.on("SIGTERM", () => void close());
