# Bridge reference

The [installation guide](../README.md#install) covers the Pi package and provider registration. The bridge connects one terminal Pi session to Paseo through a private controller socket or named pipe. Pi remains the session writer; the shim forwards native RPC between Paseo and that controller. A chat started in Paseo runs Pi in the background instead, and the same session can move between that background Pi and a terminal Pi in either direction without closing the chat.

```text
chat started in Paseo            pi --session <id> in a terminal
  Paseo <-> shim <-> background Pi  ==takeover==>  Paseo <-> shim <-> terminal Pi
                     (pi --mode rpc)  <==terminal closes==
```

Exactly one Pi writes a session at a time. The shim publishes the background Pi in the runtime registry with a private handoff socket; a terminal Pi resuming that session asks it to stop once idle before writing anything.

## Session lifecycle

| Event | Result |
| --- | --- |
| Terminal session starts with auto-connect enabled | Register the session with Paseo and accept its provider connection. |
| Send text or an image in Paseo | Deliver it to the attached Pi session through Pi's input path. |
| Stop in Paseo, or a new message that interrupts the turn | Request cancellation in Pi and answer Paseo within its two-second limit; do not terminate the terminal process. |
| Change model or thinking in Paseo | Apply the native Pi setting. Reconnection preserves the existing thinking level. |
| Disconnect the bridge | Leave Pi and its session running. |
| Paseo restarts while Pi remains open | Reconnect the existing attachment with bounded retries. |
| Terminal Pi exits, or switches to another session with `/new`, `/resume` or `/clone` | Once its runtime record is gone, continue the session in a background Pi in the same Paseo chat and say so there. A turn the terminal was running ends; unanswered requests fail with an explanation. |
| Terminal Pi disconnects with `/paseo-bridge disconnect` but keeps running | Report in Paseo that the terminal still owns the session; do not start a second writer. |
| Resume the session in a terminal | Attach to the existing Paseo agent when it can be identified. |
| Paseo starts a session without a live terminal owner | Run Pi in RPC mode in the background through the shim; the bridge's commands work there (see [Pi commands from Paseo](#pi-commands-from-paseo)). |
| Resume in a terminal a session that a background Pi runs | Take it over: the background Pi finishes its current turn, stops, and the terminal attaches to the same Paseo chat. Typing in the terminal waits until then; `/paseo-bridge takeover` stops the background turn instead of waiting. |

Paseo refuses to stop or replace an agent whose provider does not answer Stop within two seconds, and shows "active run cancellation was not acknowledged". Pi stops a turn only after its running tool exits, which can take longer, for example when a shell command keeps running after Stop. The bridge therefore answers Paseo after at most 1.5 seconds and, if Pi is still stopping, shows "Pi is still stopping the previous turn" in Paseo. The stopped turn's remaining events stay out of Paseo, and the next message from Paseo starts once Pi is idle. If Pi is still busy after 20 seconds, that message fails with an explanation; press Escape in the Pi terminal or wait for the tool, then send it again.

The shim refuses to start another Pi writer when a matching recorded owner, terminal or background, may still be alive, even if its endpoint is unavailable. This does not prevent independently launched Pi processes from opening the same file: a terminal Pi without this bridge, or with `PI_PASEO_BRIDGE=off`, does not take a background session over and must not be run on a session a Paseo chat is using.

### Taking a session over from Paseo

A terminal Pi that resumes a session finds the background Pi's record, connects to its handoff socket, and requests the session. The shim waits until the background Pi is idle (no turn, compaction, queued message or unanswered Paseo prompt), holds Paseo's next messages, stops that Pi, and removes its record. The terminal Pi then compares the session file with what it loaded at startup. If the background Pi wrote more meanwhile, the terminal reopens the session, as `/resume` does, so it continues from the latest entry. It then attaches like any terminal session, and the held messages reach it. Paseo keeps one chat for the session throughout.

While the takeover is pending, the terminal answers typed messages with a notice and sends the last one once it owns the session; images must be sent again. If the terminal does not attach within 30 seconds, the shim resumes the background Pi and reports it in Paseo. Takeover also runs with auto-connect off, because it is the only safe way for the terminal to write the session.

Session names remain native Pi data. The bridge makes no separate model request to generate titles.

## Commands

| Command | Result |
| --- | --- |
| `/paseo-bridge install` | Register this package's shim as Paseo's Pi provider command. |
| `/paseo-bridge uninstall` | Remove the registration only if it points to this package. |
| `/paseo-bridge auto on` / `off` | Save the auto-connect preference; default is on. |
| `/paseo-bridge connect` | Start attachment work for the current terminal session. |
| `/paseo-bridge disconnect` | Request bridge teardown without stopping Pi. |
| `/paseo-bridge takeover` | Take this session over from a background Pi now, stopping its current turn instead of waiting for it. |
| `/paseo-bridge status` | Show configuration, the Paseo CLI in use, auto-connect, session state, and the Pi and Paseo versions. |
| `/remote-reload` | Reload extensions and resources while idle. |

A successful `connect` response acknowledges starting attachment work, not an established Paseo connection. A disconnect acknowledgement likewise precedes teardown.

Pi's built-in `/reload` is terminal-only. Send `/remote-reload` without arguments or attachments from Paseo. Reload is rejected while generation, compaction, queued messages, or pending interactions prevent an idle reload. It does not abort work to make reload possible.

The first response acknowledges reload acceptance; `Pi runtime reloaded` confirms the replacement extension has started. The controller endpoint is retained across resource reload. Requests during the replacement gap receive an explicit retry error. A retained bridge not adopted within 90 seconds closes instead of remaining suspended.

Resource reload updates extensions, skills, prompts, themes, and context files. It does not update the Pi executable, replace a running provider shim, or restart Paseo. After package updates that change the shim, restart Paseo after active work finishes. Keep the terminal Pi sessions open for reattachment.

## Pi commands from Paseo

Pi runs its built-in commands, such as `/model` or `/session`, only in its terminal UI. Sent from Paseo as an ordinary prompt, they would reach the model as text. The bridge therefore runs the useful ones itself, lists them in Paseo's command menu, and refuses the rest with a message.

| Command | Result in Paseo |
| --- | --- |
| `/name [name]` | Show or set the session name; Paseo's title follows. |
| `/model [provider/model]` | List the available models, or switch to one (an unambiguous model ID is enough). |
| `/thinking [level]` | Show or set the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, as the model supports). |
| `/session` | Show the session file, ID, name, model, thinking level, message counts, token usage, context use and cost. |
| `/export [file.html\|file.jsonl]` | Write the session on the Pi host: HTML through Pi's own exporter, or the current branch as JSONL. Without a path, Pi picks the HTML file name. |
| `/btw <question>` | Answer a side question from the session's context with the current model, without tools. The question and answer are not saved in the session. |
| `/new <first prompt>` | Start a new Pi session in the terminal with that first prompt; Paseo imports it as its own chat once Pi saves it. |
| `/resume [number\|id\|name]` | List recent sessions of this folder, or switch the terminal to one. |
| `/clone` | Duplicate the session at its current position into a new session in the terminal. |
| `/compact`, `/autocompact` | Run by Paseo. `/autocompact` turns Pi's threshold compaction off or on for this session only; Pi still compacts when the context overflows, and Pi's settings stay unchanged. |

These commands also work in a chat started in Paseo, which runs Pi in the background. There the bridge answers them from Pi's input handler, and the shim turns its replies into the same chat output and errors, so the chat behaves as for a terminal session. `/new`, `/resume` and `/clone` are refused there, because they replace the session and Paseo cannot follow that in a chat it started; take the session over in a terminal to use them. `/autocompact` applies to the session only, as in a terminal: Pi's own RPC command would change the global setting in Pi's `settings.json`.

Notes:
- Answers appear as assistant messages, and refusals as errors, without a model turn.
- `/new`, `/resume` and `/clone` need an idle session, because they replace the terminal's session. `/new` needs a first prompt, since Paseo can import a session only after Pi saves its first message.
- An extension, prompt template or skill with the same name as a built-in wins and runs as before, except `/btw`: extensions such as pi-btw open a terminal overlay that Paseo cannot show, so the bridge answers `/btw` itself.
- Paseo interrupts a turn it started when you send a slash command, so ask `/btw` between turns or during a turn started in the terminal.
- Every other built-in (`/settings`, `/tree`, `/fork`, `/reload`, `/login`, `/quit` and others) is refused with "`/<name>` is a Pi terminal command and is not available from Paseo", plus the alternative where there is one. The bridge reads the list from the installed Pi, so built-ins that later Pi releases add are refused too.
- Notifications that extensions show with `ctx.ui.notify` also appear in Paseo while it is attached; set `PI_PASEO_BRIDGE_NOTIFICATIONS=0` to keep them in the terminal only. Status-bar entries and widgets stay in the terminal, as Paseo has no place for them.

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

Each imported session gets its own Paseo workspace in the session's directory, because Paseo's sidebar lists workspaces rather than agents and sessions sharing the folder's workspace look like one entry. The workspace ID derives from the session file, so retries and later terminal starts reuse it. Its title is the Pi session name, else the first prompt, and renaming the Pi session renames the workspace. A new session is imported once Pi has saved its first message, since Pi creates the session file only then and Paseo reads it on import. A host that cannot create the workspace, a session whose workspace was archived, and a daemon reachable only through the CLI (see [Daemon selection and remote hosts](#daemon-selection-and-remote-hosts)) import into the folder workspace instead. Sessions imported before this behavior keep their existing workspace.

## Configuration

Local TCP and socket connections import, inspect and reattach through Paseo's WebSocket API without requiring its CLI on the terminal's `PATH`. For relay or SSH targets, put `paseo` on `PATH` or set `PASEO_CLI` to its executable path. Failed imports retry with backoff capped at one minute, including when the daemon starts after Pi. Registration requires writable Paseo configuration. Existing unrelated configuration is preserved; symlinked or immutable configuration is not rewritten. Reinstalling a moved checkout updates a recognized bridge shim command to its current path.

| Variable | Effect |
| --- | --- |
| `PI_PASEO_BRIDGE=off` | Disable the extension. |
| `PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT=0` | Disable auto-connect unless overridden by saved preferences. |
| `PI_PASEO_BRIDGE_NO_IMPORT=1` | Expose the controller endpoint without automatically importing the session. |
| `PI_PASEO_BRIDGE_IMPORT_SESSIONS=0` | Disable automatic import. |
| `PI_PASEO_BRIDGE_DEBUG=1` | Write bridge debug logs, and the shim's RPC traffic to `~/.pi/paseo-bridge/shim-debug.log`. |
| `PI_PASEO_BRIDGE_HEADLESS_RESUME=0` | When the terminal Pi closes, end the Paseo chat with the resume command instead of continuing it in a background Pi. |
| `PI_PASEO_BRIDGE_TAKEOVER_WAIT_MS` | How long the shim waits for a terminal to attach after a takeover before resuming the background Pi; default 30000. |
| `PI_PASEO_BRIDGE_NOTIFICATIONS=0` | Keep extension notifications in the terminal instead of also showing them in Paseo. |
| `PI_PASEO_BRIDGE_FORCE=1` | Permit activation outside terminal UI mode for tests. |
| `PASEO_CLI` | Select the Paseo CLI executable. |
| `PASEO_HOME` | Select the local daemon's home, as for Paseo itself. Registration writes `$PASEO_HOME/config.json`. |
| `PASEO_HOST` | Select the daemon for import. TCP `host:port`, `unix://` paths, and local sockets/pipes get direct WebSocket state sync and a session workspace. Relay and SSH targets import through the CLI into the folder workspace. |
| `PASEO_PASSWORD` / `PASEO_PASSWORD_FILE` | Supply the password for a protected daemon that is not the local one. The local daemon admits the bridge with its local credential. |
| `PI_REAL_BIN` | Select the Pi executable, or its `cli.js`, for ordinary shim-launched RPC sessions. |

Saved auto-connect preferences live under Pi's configured agent directory in `paseo-bridge/settings.json`.

### Daemon selection and remote hosts

Without `PASEO_HOST`, the bridge connects to the address the local daemon publishes in `$PASEO_HOME/paseo.pid`, as Paseo's CLI does, so a non-default port or listen address needs no extra setting. It falls back to `127.0.0.1:6767` when no daemon has published an address. A password-protected local daemon admits the bridge with `$PASEO_HOME/local-credential`, so `PASEO_PASSWORD` is not needed. The credential is sent only to the address in that pid file.

Pi and the daemon importing its sessions must run on the same machine under the same user: Paseo reads the session file by path, and the daemon's shim attaches to the Pi terminal through a local socket recorded under `~/.pi/paseo-bridge`. Pointing `PASEO_HOST` at a daemon on another machine cannot import a session. To use Pi on another machine, install Paseo and the bridge there and add that daemon as a host in the Paseo app, for example with `paseo host add` or by pairing the app with it; its sessions then appear under that host.

A daemon that listens only on a Unix socket or Windows named pipe uses the same direct WebSocket requests as TCP, preserving separate workspaces and settings sync. Its local credential is sent only when the selected socket matches the listener in the local daemon's pid file. Relay or pairing URLs and SSH targets use the CLI, which honors `PASEO_HOST`, `PASEO_HOME` and `PASEO_PASSWORD`. Paseo's CLI cannot choose a workspace, so those sessions land in the folder workspace and model, thinking-level and title changes are not synced.

The saved session-to-agent map is a cache. If it is lost or an import response is lost, a direct connection recovers an existing Pi agent by its full native session-file path in Paseo's directory. The search checks up to 10,000 entries or 200 pages, rejects repeated cursors, and ignores archived agents. An already-attached controller is reused without refreshing it, because Paseo refresh interrupts an active turn. Previously imported sessions keep their existing workspace.

## Compatibility

The bridge does not enforce a Pi or Paseo runtime version. It uses public interfaces, but a newer release can still change their behavior. A Pi or Paseo release newer than the reviewed minor line, a pre-release, or one older than the minimum produces a one-time warning in the terminal (Pi at session start, Paseo when the daemon first admits the bridge's WebSocket connection); `/paseo-bridge status` shows both versions. `extension/version-support.ts` holds this range. Pi packages are declared as `"*"` peer dependencies, as Pi requires for host-provided packages; development dependencies are pinned for reproducible checks.

| Component | Minimum | Latest reviewed/tested target |
| --- | --- | --- |
| Pi (`@earendil-works/pi-coding-agent`) | 1.0.0 | 1.6.0 |
| Paseo (`@getpaseo/server`, `@getpaseo/cli`) | 0.13.0 | 0.17.1 |

How the latest releases compare with the minimums:

- **Pi 1.6.0:** the [release changelog](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/CHANGELOG.md) changes TUI rendering to readonly buffers; the bridge does not render custom components. The public extension events, ordinary dialog methods and SDK exports used here still typecheck. Native RPC session replacements no longer emit duplicate `session_start` events, and SDK reload emits the missing startup event. Pi still creates a new session file only after its first user or assistant message; the bridge waits for that file instead of creating one itself.
- **Paseo 0.17.1:** the Pi provider sends the same RPC commands and accepts the same capture markers, WebSocket requests, CLI commands (`import`, `inspect`, `agent reload`), and `agents.providers.pi.command` configuration. It reads `isStreaming`, `isCompacting`, and `pendingMessageCount` from `get_state` before stopping an idle runtime, which the bridge reports, and it extracts images from forwarded tool results itself. It reads history from the `sessionFile` that `get_state` reports rather than calling `get_messages`, and uses only `treeEntries` from entry captures; the bridge still answers `get_messages` and sends `contextEntries` for earlier releases. Because import reads the session file, which Pi creates only once the conversation starts, the bridge imports a new session after Pi saves its first message. Reading the timeline of an agent the daemon has not loaded opens a short-lived history-only session; when it closes, the bridge has Paseo reload the agent so the terminal session stays attached. The provider also shows `command_output` frames, completes prompts that start no model turn, and lists the commands `get_commands` returns, which the bridge uses for the commands above.

### Checking a new release

For a new Pi release:

1. Read the changelog's breaking changes for extension events (`session_start`, `session_shutdown`, `agent_*`, `turn_*`, `message_*`, `tool_execution_*`, `session_*compact*`, `model_select`, `thinking_level_select`, `session_info_changed`), `ctx.ui.select`/`input`/`confirm`, `pi.sendUserMessage`, `ctx.reload`, `ctx.compact`, and the `buildSessionProjection` and `getAgentDir` exports.
2. Install it with `npm install -D --save-exact @earendil-works/pi-coding-agent@<version> @earendil-works/pi-ai@<version>`, then run `npm run typecheck` and the full test suite with `TEST_PI_BIN` and `BRIDGE_NATIVE_PI` pointing to the new `pi`.
3. If everything passes, raise `PI_TESTED_VERSION` in `extension/version-support.ts`; a test checks that it matches the pinned devDependency.

For a new Paseo release:

1. Compare `dist/server/server/agent/providers/pi/cli-runtime.js` and `rpc-types.d.ts` with the previous release. Every RPC command it sends must be handled in `handleCommand` or answered with Pi's `Unknown command` error.
2. Check that `agent.js` still uses the `PASEO_ENTRY_CAPTURE`, `PASEO_SUBMITTED_USER_ENTRY`, and `PASEO_COMMAND_RESULT` markers and the `paseo_capture_entries` and `paseo_tree` commands.
3. Check the CLI's `import`, `inspect --json` (`Archived` field), and `agent reload` commands, the WebSocket `hello` handshake and the `workspace.create.request` (with `workspaceId`), `import_agent_request` (with `workspaceId`), `fetch_agent_request`, `fetch_agents_request`, `refresh_agent_request`, `workspace.title.set.request`, `set_agent_model_request`, `set_agent_thinking_request`, `update_agent_request`, and `agent_permission_response` messages, and the `agents.providers.pi.command` configuration schema.
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

`test/session-host.test.ts` checks the shim against a scripted Pi: command frames, deferred `/btw`, per-session `/autocompact`, takeover once idle, continuation after the terminal closes, and refusal while a disconnected terminal still owns the session. `test/headless-commands.test.ts` runs the pinned Pi in RPC mode through the shim. The stock-daemon test "a chat started in Paseo moves to a terminal Pi and back" creates a chat in Paseo, runs the bridge's commands in it, takes it over with a terminal Pi, reaches that Pi from the same chat, closes the terminal, and continues in Paseo.

The stock-daemon test runs a published Paseo server of version 0.13.0 or newer in-process, with the CLI of the same version. It uses the real Pi SDK extension runner with a controlled terminal renderer, ordinary `ctx.ui` calls, and the production shim. It checks import, a separate workspace for each session in one folder, deferred import of a new session until Pi saves it, reattachment after a history-only read of an unloaded agent, app and terminal choices, cancellation, Stop and replacement of a turn whose tool ignores cancellation, timeout, reload, pending-question cleanup, and callback delivery after the actual controller response. It uses the development Pi SDK by default; set `BRIDGE_PI_SDK` to another installed package's absolute `dist/index.js` to check that SDK. Tests requiring an executable or provider path are skipped when that environment variable is absent.

With Pi 1.6.0, `npm test` and `npm run typecheck` pass, and `npm run test:native` passes against Paseo 0.17.1 and 0.16.2 except one test: "reading an unloaded agent's history leaves the terminal session attached" fails with both, unrelated to the command handling. `test/session-switch.integration.ts` runs a standalone `pi --mode rpc` for `/new`, `/resume` and `/clone`, because a session seeded with a very large history exceeds Paseo's 16 MiB capture frame when the switch test attaches to it.

Desktop and Android use stock Paseo interfaces; backend callback delivery and native provider tests do not prove Android layout, gestures, or visual acceptance. No Android visual acceptance is claimed.
