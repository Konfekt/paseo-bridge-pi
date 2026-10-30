# Bridge reference

The [installation guide](../README.md#install) covers the Pi package and provider registration. The bridge connects one terminal Pi session to Paseo through a private controller socket or named pipe. Pi remains the session writer; the shim forwards native RPC between Paseo and that controller.

## Session lifecycle

| Event | Result |
| --- | --- |
| Terminal session starts with auto-connect enabled | Register the session with Paseo and accept its provider connection. |
| Send text or an image in Paseo | Deliver it to the attached Pi session through Pi's input path. |
| Stop in Paseo | Request cancellation in Pi; do not terminate the terminal process. |
| Change model or thinking in Paseo | Apply the native Pi setting. Reconnection preserves the existing thinking level. |
| Disconnect the bridge | Leave Pi and its session running. |
| Paseo restarts while Pi remains open | Reconnect the existing attachment with bounded retries. |
| Terminal Pi exits | Report the resume command in Paseo; do not silently create a replacement writer for that attachment. |
| Resume the session in a terminal | Attach to the existing Paseo agent when it can be identified. |
| Paseo starts a session without a live terminal owner | Run ordinary Pi RPC through the shim. |

The shim refuses to start another Pi writer when a matching recorded terminal owner may still be alive, even if its endpoint is unavailable. This does not prevent independently launched Pi processes from opening the same file. Do not run a second terminal Pi on a session that Paseo already owns through ordinary RPC.

Session names remain native Pi data. The bridge makes no separate model request to generate titles.

## Commands

| Command | Result |
| --- | --- |
| `/paseo-bridge install` | Register this package's shim as Paseo's Pi provider command. |
| `/paseo-bridge uninstall` | Remove the registration only if it points to this package. |
| `/paseo-bridge auto on` / `off` | Save the auto-connect preference; default is on. |
| `/paseo-bridge connect` | Start attachment work for the current terminal session. |
| `/paseo-bridge disconnect` | Request bridge teardown without stopping Pi. |
| `/paseo-bridge status` | Show configuration, auto-connect, and session state. |
| `/remote-reload` | Reload extensions and resources while idle. |

A successful `connect` response acknowledges starting attachment work, not an established Paseo connection. A disconnect acknowledgement likewise precedes teardown.

Pi's built-in `/reload` is terminal-only. Send `/remote-reload` without arguments or attachments from Paseo. Reload is rejected while generation, compaction, queued messages, or pending interactions prevent an idle reload. It does not abort work to make reload possible.

The first response acknowledges reload acceptance; `Pi runtime reloaded` confirms the replacement extension has started. The controller endpoint is retained across resource reload. Requests during the replacement gap receive an explicit retry error. A retained bridge not adopted within 90 seconds closes instead of remaining suspended.

Resource reload updates extensions, skills, prompts, themes, and context files. It does not update the Pi executable, replace a running provider shim, or restart Paseo. After package updates that change the shim, restart Paseo after active work finishes. Keep the terminal Pi sessions open for reattachment.

When updating from the former dashboard/tmux version, also restart existing Pi processes after active work finishes. Resource reload retains transport objects and cannot remove servers already created by that version. No automatic live-state migration is performed.

If the former optional Paseo plugin is installed, remove its separate registration:

```sh
paseo plugin remove paseo-permission-gate
```

This removes the optional UI, not Pi's permission enforcement. Updating the Pi package alone does not uninstall a Paseo plugin.

## Remote questions

Ordinary Pi RPC and terminal attachment have different UI boundaries:

| Runtime | Interaction route |
| --- | --- |
| Pi launched in RPC mode by Paseo | Pi emits its ordinary RPC UI requests; Paseo presents native questions. |
| Existing terminal Pi attached through the bridge | Ordinary `ctx.ui.select`, `input`, and `confirm` calls appear in both the terminal and Paseo. |

No bridge-specific API is required in dialog-producing extensions. The bridge wraps Pi's public UI methods at session startup, restores its own bindings on shutdown, and binds again after reload or session replacement. RPC mode is not wrapped. Without an attached controller, the original terminal UI runs unchanged; dialogs already open when Paseo attaches remain terminal-local.

Select and input return the selected text or `undefined` on cancellation. Confirmation returns a boolean; cancellation is `false`, matching Pi. Abort signals and timeouts dismiss both interfaces. Provider Stop, controller disconnect, and session shutdown cancel pending mirrored dialogs. Paseo's app Stop applies to tracked agent runs, not idle terminal extension commands. These are live Pi callbacks, not durable questions recoverable after Pi exits.

Custom TUI components and multiline editors remain terminal-local. Startup dialogs opened before the bridge's startup handler, or calls through method references captured before binding, cannot be intercepted. For startup-dialog mirroring, load the bridge before extensions that open those dialogs. The adapter uses the shared public UI object tested with stock Pi 1.0.0 and 1.1.0; Pi has no dedicated dialog interception hook. Mirrored confirmation uses the original Yes/No selector to distinguish No from cancellation, so its terminal UI prompt event has kind `select`.

Paseo renders the request with its existing question components. The bridge receives the response through the provider, resolves the original Pi callback, and settles mirrored local/remote choices once. A local choice dismisses its pending Paseo question; duplicate or late remote replies must not execute the callback again. A visible choice alone is not proof of delivery: the owning callback must receive the result.

Local choices complete only after the response returns through the controller. If submission fails, the callback remains pending and a notice directs the response to Paseo. Cancellation settles locally even when the daemon is unreachable; failed dismissal is reported, and the stale question may need dismissal in the app.

Permission questions remain subject to Pi's existing gate and authorization policy. The bridge neither disables enforcement nor infers approval from chat text.

## Remote command limits

Bridge-owned commands have explicit remote routes. Other extension commands, skill commands, and prompt templates use Pi's public `sendUserMessage` path with command/template expansion enabled, including steer and follow-up delivery. Known extension commands reject image attachments because Pi passes only text to their handlers.

On stock Pi, submission confirms acceptance only. It does not prove that a command completed, input hooks consumed the message, or model work started. Observe results separately. Awaited replies remain bound to their controller/runtime epoch; resource reload cannot deliver an old reply into a replacement binding. No fork-only command-outcome API or optional pre-send service is used.

Retained history comes from Pi. Timeline rewind from Paseo is not supported for attached terminal sessions. Paseo's MCP injection applies to its ordinary RPC sessions, not an already-running terminal session. The bridge does not convert native text-history forks into interactive terminals.

## Configuration

The `paseo` CLI must be on `PATH`, or set `PASEO_CLI` to its executable path. Registration requires writable Paseo configuration. Existing unrelated configuration is preserved; symlinked or immutable configuration is not rewritten.

| Variable | Effect |
| --- | --- |
| `PI_PASEO_BRIDGE=off` | Disable the extension. |
| `PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT=0` | Disable auto-connect unless overridden by saved preferences. |
| `PI_PASEO_BRIDGE_NO_IMPORT=1` | Expose the controller endpoint without automatically importing the session. |
| `PI_PASEO_BRIDGE_IMPORT_SESSIONS=0` | Disable automatic import. |
| `PI_PASEO_BRIDGE_DEBUG=1` | Write bridge debug logs. |
| `PI_PASEO_BRIDGE_FORCE=1` | Permit activation outside terminal UI mode for tests. |
| `PASEO_CLI` | Select the Paseo CLI executable. |
| `PASEO_HOST` | Select the daemon for CLI import. URL/relay targets skip direct WebSocket state sync. |
| `PASEO_PASSWORD` / `PASEO_PASSWORD_FILE` | Supply credentials for an authenticated daemon. |
| `PI_REAL_BIN` | Select the Pi executable, or its `cli.js`, for ordinary shim-launched RPC sessions. |

Saved auto-connect preferences live under Pi's configured agent directory in `paseo-bridge/settings.json`.

## Verification

Use `npm test`, `npm run typecheck`, and `npm pack --dry-run` for source and package checks. No formatter or linter is configured. Native fixtures use isolated homes and no model calls or live user sessions:

```sh
TEST_PI_BIN="$(command -v pi)" npm test
BRIDGE_NATIVE_PI="$(command -v pi)" TEST_PI_BIN="$(command -v pi)" \
  PASEO_CLI="$(command -v paseo)" \
  BRIDGE_STOCK_PASEO_PI_PROVIDER=/path/to/paseo/server/dist/server/server/agent/providers/pi/agent.js \
  npm run test:native
```

The stock-daemon proof targets published Paseo 0.13.0 and needs its matching CLI. It uses the real Pi SDK extension runner with a controlled terminal renderer, ordinary `ctx.ui` calls, and the production shim. It checks import, app and terminal choices, cancellation, timeout, reload, pending-question cleanup, and callback delivery after the actual controller response. It uses the development Pi SDK by default; set `BRIDGE_PI_SDK` to another installed package's absolute `dist/index.js` to check that SDK. Tests requiring an executable or provider path are skipped when that environment variable is absent.

Desktop and Android use stock Paseo interfaces; backend callback delivery and native provider tests do not prove Android layout, gestures, or visual acceptance. No Android visual acceptance is claimed.
