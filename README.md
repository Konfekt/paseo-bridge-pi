# Pi ↔ Paseo

Attach a terminal Pi conversation to stock Paseo. Read history, send messages, stop generation, and change model settings from Paseo while the same session remains open in the terminal.

## Install

Requires Pi 1.x, Node.js 22+, and Paseo 0.13.0+. Install the package on the Paseo daemon host, under the same account as Pi:

```sh
pi install git:github.com/Konfekt/paseo-bridge-pi
```

Inside Pi, run:

```text
/paseo-bridge install
```

This registers the provider shim in writable Paseo configuration. After active work finishes, restart the daemon:

```sh
paseo restart
```

Start a terminal Pi session. Auto-connect is enabled by default; `/paseo-bridge status` reports the connection state. No additional Paseo plugin, custom application build, or package compiler is required.

## Controls

| Command | Effect |
| --- | --- |
| `/paseo-bridge connect` | Attach the current session. |
| `/paseo-bridge disconnect` | Detach without stopping Pi. |
| `/paseo-bridge auto on` / `off` | Set auto-connect for subsequent sessions. |
| `/paseo-bridge status` | Inspect configuration and connection state. |
| `/remote-reload` | Reload Pi resources while idle, including from Paseo. |

Paseo uses its native chat and question interfaces. Attached terminal sessions mirror ordinary Pi select, input, and confirmation dialogs. Respond in either interface; the result returns to the original Pi callback once. Dialog-producing extensions need no bridge-specific integration. See the [reference](docs/reference.md) for lifecycle limits.

The bridge preserves Pi's permission enforcement. It adds no permission-mode control, account dashboard, subagent projection, terminal orchestration, or automatic title-generation request. Android visual acceptance remains unverified.

## Development

```sh
npm install
npm test
npm run typecheck
npm run test:native
npm pack --dry-run
```

Native integration tests require an installed Pi executable; see [verification](docs/reference.md#verification). A checkout can be registered with `npm run dev-install` and removed with `npm run dev-uninstall`.

## Uninstall

Run `/paseo-bridge uninstall` inside Pi, then remove the package and restart Paseo:

```sh
pi remove git:github.com/Konfekt/paseo-bridge-pi
paseo restart
```

## License

MIT; see [package metadata](package.json).
