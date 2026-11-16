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
| `/paseo-bridge status` | Show configuration, the Paseo CLI in use, auto-connect, session state, and the Pi and Paseo versions. |
| `/remote-reload` | Reload extensions and resources while idle. |

A successful `connect` response acknowledges starting attachment work, not an established Paseo connection. A disconnect acknowledgement likewise precedes teardown.

Pi's built-in `/reload` is terminal-only. Send `/remote-reload` without arguments or attachments from Paseo. Reload is rejected while generation, compaction, queued messages, or pending interactions prevent an idle reload. It does not abort work to make reload possible.

The first response acknowledges reload acceptance; `Pi runtime reloaded` confirms the replacement extension has started. The controller endpoint is retained across resource reload. Requests during the replacement gap receive an explicit retry error. A retained bridge not adopted within 90 seconds closes instead of remaining suspended.

Resource reload updates extensions, skills, prompts, themes, and context files. It does not update the Pi executable, replace a running provider shim, or restart Paseo. After package updates that change the shim, restart Paseo after active work finishes. Keep the terminal Pi sessions open for reattachment.

## Remote questions

Ordinary Pi RPC and terminal attachment have different UI boundaries:

| Runtime | Interaction route |
| --- | --- |
| Pi launched in RPC mode by Paseo | Pi emits its ordinary RPC UI requests; Paseo presents native questions. |
| Existing terminal Pi attached through the bridge | Ordinary `ctx.ui.select`, `input`, and `confirm` calls appear in both the terminal and Paseo. |

No bridge-specific API is required in extensions using ordinary Pi dialogs. The bridge wraps Pi's public UI methods at session startup, restores its own bindings on shutdown, and binds again after reload or session replacement. RPC mode is not wrapped. Without an attached controller, the original terminal UI runs unchanged; dialogs already open when Paseo attaches remain terminal-local.

Select and input return the selected text or `undefined` on cancellation. Confirmation returns a boolean; cancellation is `false`, matching Pi. Abort signals and timeouts dismiss both interfaces. Provider Stop, controller disconnect, and session shutdown cancel pending mirrored dialogs. Paseo's app Stop applies to tracked agent runs, not idle terminal extension commands. These are live Pi callbacks, not durable questions recoverable after Pi exits.

Custom TUI components and multiline editors remain terminal-local. Startup dialogs opened before the bridge's startup handler, or calls through method references captured before binding, cannot be intercepted. For startup-dialog mirroring, load the bridge before extensions that open those dialogs. The adapter wraps Pi's shared public UI object; Pi has no dedicated dialog interception hook. Mirrored confirmation uses the original Yes/No selector to distinguish No from cancellation, so its terminal UI prompt event has kind `select`.

Paseo renders the request with its existing question components. The bridge receives the response through the provider, resolves the original Pi callback, and settles mirrored local/remote choices once. A local choice dismisses its pending Paseo question; duplicate or late remote replies must not execute the callback again. A visible choice alone is not proof of delivery: the owning callback must receive the result.

Local choices complete only after the response returns through the controller. If submission fails, the callback remains pending and a notice directs the response to Paseo. Cancellation settles locally even when the daemon is unreachable; failed dismissal is reported, and the stale question may need dismissal in the app.

Permission questions remain subject to Pi's existing gate and authorization policy. The bridge neither disables enforcement nor infers approval from chat text.

### Incompatible question package

`@juicesharp/rpiv-ask-user-question` is a third-party Pi package, not a built-in Pi tool. It uses a custom widget in terminal mode. Stock Paseo creates an "Ask user question" form from the tool call, but routes answers through ordinary select/input requests. The custom widget emits neither, so app submission can dismiss the permission without completing the Pi tool. This affects terminal-attached sessions, not the package's ordinary RPC-mode dialog path.

Disable the package's extensions with `pi config`, or keep its package entry with an empty extension filter in Pi settings:

```json
{
  "source": "npm:@juicesharp/rpiv-ask-user-question",
  "extensions": []
}
```

This removes the package's `ask_user_question` tool on the next reload or start; Pi has no built-in replacement with that name. Other extensions' ordinary select/input/confirmation dialogs and permission enforcement remain available. The bridge adds no RPIV-specific adapter.

Disabling a package does not unload an already-open widget. Complete or cancel that dialog in the terminal, wait for Pi to become idle, then run `/reload` locally or `/remote-reload` from Paseo. An app submission made before disabling does not retroactively reach the widget.

Package installation prints a compatibility warning through its npm postinstall hook; `/paseo-bridge install` and `npm run dev-install` also warn. These notices do not alter other packages. If package-manager lifecycle scripts are disabled, the in-Pi setup warning remains available.

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

## Compatibility

The bridge pins no Pi or Paseo version and never refuses one. It relies only on public interfaces that both projects keep stable, so newer releases keep working. A Pi or Paseo release newer than the latest verified minor line, a pre-release, or one older than the minimum produces a one-time warning in the terminal (Pi at session start, Paseo when the daemon first admits the bridge's WebSocket connection); `/paseo-bridge status` shows both versions. `extension/version-support.ts` holds the verified range. Pi packages are declared as `"*"` peer dependencies, as Pi requires for host-provided packages.

| Component | Minimum | Latest verified |
| --- | --- | --- |
| Pi (`@earendil-works/pi-coding-agent`) | 1.0.0 | 1.5.2 |
| Paseo (`@getpaseo/server`, `@getpaseo/cli`) | 0.13.0 | 0.15.4 |

How the latest releases compare with the minimums:

- **Pi 1.5.2:** every extension event, `ctx.ui` method, and SDK export the bridge uses is unchanged. Pi now treats a starting run as busy and requires `deliverAs` for `sendUserMessage` while busy; the bridge already sends `followUp` whenever Pi is not idle. `agent_settled` now carries `aborted`; the bridge does not depend on it. No deprecations affect the bridge.
- **Paseo 0.15.4:** the Pi provider sends the same RPC commands and accepts the same capture markers, WebSocket requests, CLI commands (`import`, `inspect`, `agent reload`), and `agents.providers.pi.command` configuration. New: it reads `isStreaming`, `isCompacting`, and `pendingMessageCount` from `get_state` before stopping an idle runtime, which the bridge reports, and it extracts images from forwarded tool results itself.
- **Paseo 0.16 (beta):** the stock-daemon test passes. Paseo reads history from the `sessionFile` reported by `get_state` instead of calling `get_messages`, no longer reads `contextEntries` from entry captures, and opens short-lived history-only sessions for agents that are not loaded. Before relying on 0.16, check in the app that opening an unloaded agent's timeline while its terminal session is live leaves that session attached.

### Checking a new release

For a new Pi release:

1. Read the changelog's breaking changes for extension events (`session_start`, `session_shutdown`, `agent_*`, `turn_*`, `message_*`, `tool_execution_*`, `session_*compact*`, `model_select`, `thinking_level_select`, `session_info_changed`), `ctx.ui.select`/`input`/`confirm`, `pi.sendUserMessage`, `ctx.reload`, `ctx.compact`, and the `buildSessionProjection` and `getAgentDir` exports.
2. Install it with `npm install -D --save-exact @earendil-works/pi-coding-agent@<version> @earendil-works/pi-ai@<version>`, then run `npm run typecheck` and the full test suite with `TEST_PI_BIN` and `BRIDGE_NATIVE_PI` pointing to the new `pi`.
3. If everything passes, raise `PI_TESTED_VERSION` in `extension/version-support.ts`; a test checks that it matches the pinned devDependency.

For a new Paseo release:

1. Compare `dist/server/server/agent/providers/pi/cli-runtime.js` and `rpc-types.d.ts` with the previous release. Every RPC command it sends must be handled in `handleCommand` or answered with Pi's `Unknown command` error.
2. Check that `agent.js` still uses the `PASEO_ENTRY_CAPTURE`, `PASEO_SUBMITTED_USER_ENTRY`, and `PASEO_COMMAND_RESULT` markers and the `paseo_capture_entries` and `paseo_tree` commands.
3. Check the CLI's `import`, `inspect --json` (`Archived` field), and `agent reload` commands, the WebSocket `hello` handshake and the `set_agent_model_request`, `set_agent_thinking_request`, `update_agent_request`, and `agent_permission_response` messages, and the `agents.providers.pi.command` configuration schema.
4. Run `npm run test:native` against the new server and CLI, as described below.
5. If everything passes, raise `PASEO_TESTED_VERSION` in `extension/version-support.ts`.

## Verification

Use `npm test`, `npm run typecheck`, and `npm pack --dry-run` for source and package checks. No formatter or linter is configured. Native fixtures use isolated homes and no model calls or live user sessions:

```sh
TEST_PI_BIN="$(command -v pi)" npm test
BRIDGE_NATIVE_PI="$(command -v pi)" TEST_PI_BIN="$(command -v pi)" \
  PASEO_CLI="$(command -v paseo)" \
  BRIDGE_STOCK_PASEO_PI_PROVIDER=/path/to/paseo/server/dist/server/server/agent/providers/pi/agent.js \
  npm run test:native
```

The stock-daemon test runs a published Paseo server of version 0.13.0 or newer in-process, with the CLI of the same version. It uses the real Pi SDK extension runner with a controlled terminal renderer, ordinary `ctx.ui` calls, and the production shim. It checks import, app and terminal choices, cancellation, timeout, reload, pending-question cleanup, and callback delivery after the actual controller response. It uses the development Pi SDK by default; set `BRIDGE_PI_SDK` to another installed package's absolute `dist/index.js` to check that SDK. Tests requiring an executable or provider path are skipped when that environment variable is absent.

Desktop and Android use stock Paseo interfaces; backend callback delivery and native provider tests do not prove Android layout, gestures, or visual acceptance. No Android visual acceptance is claimed.
