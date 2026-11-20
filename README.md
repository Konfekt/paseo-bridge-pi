# Pi ↔ Paseo

Attach a terminal Pi conversation to stock Paseo. Read history, send messages, stop generation, and change model settings from Paseo while the same session remains open in the terminal.

## Install

Requires Pi 1.0.0 or newer and Paseo 0.13.0 or newer; newer releases are expected to work without a bridge update and get a one-time warning until verified (see [compatibility](docs/reference.md#compatibility)). Install the package on the Paseo daemon host, under the same account as Pi. For Pi on another machine, run Paseo and the bridge there and add that daemon as a host in the app (see [remote hosts](docs/reference.md#daemon-selection-and-remote-hosts)):

```sh
pi install git:github.com/Konfekt/paseo-bridge-pi
```

**Incompatible package:** `@juicesharp/rpiv-ask-user-question` uses a custom terminal widget whose answers cannot be delivered from stock Paseo. Disable its extensions with `pi config` for terminal-attached sessions, then reload Pi while idle. Package installation and `/paseo-bridge install` print this warning; neither changes other packages. See [details and pending-dialog recovery](docs/reference.md#incompatible-question-package).

Inside Pi, run:

```text
/paseo-bridge install
```

This registers the provider shim in writable Paseo configuration. After active work finishes, restart the daemon:

```sh
paseo restart
```

Start a terminal Pi session. Auto-connect is enabled by default; `/paseo-bridge status` reports the connection state. No additional Paseo plugin, custom application build, or package compiler is required.

Each session appears in its own Paseo workspace once Pi saves its first message. An empty start screen has no session file yet. Local TCP and Unix-socket daemons are discovered automatically, even when `paseo` is absent from the terminal's `PATH`; the CLI remains necessary for relay or SSH targets. The bridge retries while the daemon starts and reuses existing imports after a terminal restart.

After updating or moving the bridge checkout, register its current location in Pi, replacing the old package entry if the path changed. In each already-open idle Pi session, run `/reload` first, then `/paseo-bridge install`, so installation uses the updated extension. Apply the configuration with `paseo reload` while idle, or `paseo restart` to replace running shim processes. Reinstallation refreshes a previous bridge shim path while preserving unrelated provider settings.

Pi's `/reload` updates resources, including extensions; it does not replace the running Pi executable. After upgrading Pi to 1.6.0, exit the old process while idle and reopen or resume its session with the updated executable.

## Controls

| Command | Effect |
| --- | --- |
| `/paseo-bridge connect` | Attach the current session. |
| `/paseo-bridge disconnect` | Detach without stopping Pi. |
| `/paseo-bridge auto on` / `off` | Set auto-connect for subsequent sessions. |
| `/paseo-bridge status` | Inspect configuration and connection state. |
| `/remote-reload` | Reload Pi resources while idle, including from Paseo. |

Paseo uses its native chat and question interfaces. Attached terminal sessions mirror ordinary Pi select, input, and confirmation dialogs. Respond in either interface; the result returns to the original Pi callback once. Extensions using these ordinary dialogs need no bridge-specific integration; custom terminal widgets remain local. See the [reference](docs/reference.md) for lifecycle limits.

The bridge preserves Pi's permission enforcement. It adds no permission-mode control, account dashboard, subagent projection, terminal orchestration, or automatic title-generation request. Android visual acceptance remains unverified.

## Development

```sh
npm install
npm test
npm run typecheck
npm run test:native
npm pack --dry-run
```

Native integration tests require an installed Pi executable and, for the stock-daemon test, a Paseo installation; see [verification](docs/reference.md#verification). A checkout can be registered with `npm run dev-install` and removed with `npm run dev-uninstall`.

## Uninstall

Run `/paseo-bridge uninstall` inside Pi, then remove the package and restart Paseo:

```sh
pi remove git:github.com/Konfekt/paseo-bridge-pi
paseo restart
```

## License

MIT; see [package metadata](package.json).
