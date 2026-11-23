// A stand-in for `pi --mode rpc` with the bridge extension loaded, speaking
// the shim frame protocol. Used by test/session-host.test.ts.
import fs from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : process.env.FAKE_SESSION_FILE;
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ pid: process.pid, args })}\n`);
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const frame = value => out({ type: "extension_ui_request", id: `n${Math.random()}`, method: "notify", message: `PI_PASEO_BRIDGE_FRAME ${JSON.stringify(value)}`, notifyType: "info" });
let busyUntil = 0;
if (process.env.PI_PASEO_BRIDGE_SHIM_PROTOCOL === "1") {
  frame({ op: "commands", commands: [{ name: "model", description: "Switch models" }, { name: "btw", description: "Side question" }], capabilities: { autocompact: true } });
}
process.on("SIGTERM", () => process.exit(0));
createInterface({ input: process.stdin }).on("line", line => {
  const cmd = JSON.parse(line);
  const ok = data => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data ? { data } : {}) });
  switch (cmd.type) {
    case "get_state":
      ok({ sessionFile, isStreaming: Date.now() < busyUntil, isCompacting: false, pendingMessageCount: 0, autoCompactionEnabled: true });
      return;
    case "get_commands":
      ok({ commands: [{ name: "skill:demo", source: "skill" }, { name: "model", source: "extension" }] });
      return;
    case "abort":
      busyUntil = 0;
      ok();
      return;
    case "prompt": {
      const message = cmd.message;
      if (message === "/busy") {
        busyUntil = Date.now() + Number(process.env.FAKE_BUSY_MS ?? 1500);
        out({ type: "agent_start" });
        ok({ disposition: "started" });
        setTimeout(() => out({ type: "agent_end", messages: [] }), Number(process.env.FAKE_BUSY_MS ?? 1500));
      } else if (message === "/out") {
        frame({ op: "output", text: "hello from pi" });
        ok({ disposition: "handled" });
      } else if (message.startsWith("/btw")) {
        frame({ op: "defer", message });
        ok({ disposition: "handled" });
        setTimeout(() => { frame({ op: "output", text: "btw answer" }); frame({ op: "done", message }); }, 100);
      } else if (message === "/bad") {
        frame({ op: "fail", message, error: "bad command" });
        ok({ disposition: "handled" });
      } else if (message.startsWith("/paseo-bridge headless-autocompact")) {
        const [, , value, token] = message.split(" ");
        frame({ op: "autocompact", enabled: value === "on" });
        frame({ op: "reply", token, ok: true });
        ok({ disposition: "handled" });
      } else {
        ok({ disposition: "started" });
        out({ type: "echo", message });
      }
      return;
    }
    default:
      ok({ echo: cmd.type });
  }
});
