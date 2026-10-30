# Historical managed adapter reachability audit

This audit describes the former fork-compiled renderer, not the current plugin. Stock-Paseo tool details now use [plain-text presentation](transcript-presentation.md); the native mapper extraction and parity claims below are historical evidence only. Runtime/control integrations remain separate from rendering.

This is a concrete configured-runtime audit, not a claim of universal compatibility with every Pi extension.

## Evidence

`.dev/transcript-browser/managed-runtime-inventory.json` records the immutable active settings source, selected auto-extension folders and bounded historical-name counts. The audit read only package/extension configuration and tool **names/marker counts**; it did not export messages, arguments, credentials, ownership manifests or session-file paths.

- Active `PI_CODING_AGENT_DIR`: `/home/theo/.config-adelaide/pi`.
- Its immutable settings selected the bridge package; auto-discovery selected this fork's background-job, subagent, workflows, progress, questionnaire, sandbox, fetch, SSH and other UI/provider extensions, plus the fast-mode provider helper. No gotgenes/tintinweb/rpiv/goal-x/MCP-adapter package was selected.
- No project `.pi/settings.json` or `.pi/extensions` existed at the six audited current managed project roots.
- All **33** valid extant bounded worker session files were scanned (**53,316,438 bytes**, **0 skipped files**). None contained tool calls named `bg_wait`, `Agent`, `get_subagent_result`, `steer_subagent`, `ask_user_question`, `ask_user`, `todo`, `create_goal`, `get_goal`, `update_goal`, `set_goal_tasks`, `update_goal_task`, or `mcp`.
- **104** recorded subagent results carried the managed `tui_subagent` marker.
- Managed TUI/headless launchers explicitly inherit `getAgentDir()`; the sandboxed legacy branch uses explicit trusted extension entrypoints with `--no-extensions`. Managed response factories put `tui_subagent: true` in terminal tool details.

## Reachable native override: fixed, not declared unknown

The native `pi-subagents` adapter is registered before the optional alternatives. Managed terminal markers and old synthetic call IDs select its normal mapper path. An in-flight launch has no terminal marker yet, however; a plain-text failure may also lack one. Its existing pure argument/detail/opt-out projection was therefore extracted into `extensions/pi-subagents/presentation.ts` and is now used by both the native adapter and bundled presentation facade. Runtime discovery, hydration, private file reads and provider-subagent events remain in the original server adapter.

The extracted projection was compared against the actual installed native adapter for running, plain-text failure and managed terminal records: **9/9 identical**. Focused package tests also cover the pure precedence and synthetic history marker. This is the only observed/reachable optional-adapter presentation override in the configured managed paths; it is not routed through an invented unknown formatter.

## Classifications

| Native integration | Actual managed tool presentation | Classification |
| --- | --- | --- |
| Normal Pi tools and named fork tools | Bundled native argument/result parser, detail mapper, error and protocol display | Supported/reachable |
| Managed subagent start / marker-less failure / terminal marker | Shared extracted native pure presentation projection + normal native mapper | Supported/reachable |
| `update_progress` native todo activity | Tool detail stays normal native mapper; additional todo timeline projection uses server crypto/state and native timeline UI | Tool presentation supported; additional activity out-of-band |
| Native questionnaire / ask-user dialogs | Questionnaire tool detail stays normal native mapper; pending interactive controls retain their existing task/worker-bound flow | Tool presentation supported; dialog runtime out-of-band |
| `bg_wait`, tintinweb `Agent`, gotgenes/tintinweb result/steer tools | Not registered in audited profile/current project discovery; absent from all scanned worker history | Optional third-party runtime integration excluded by evidence |
| rpiv `ask_user_question`, todo examples and goal-x tool names | Same absent registration/history evidence | Optional third-party runtime integration excluded by evidence |
| Wrapper tool `mcp` | No active adapter package/registration; current daemon configuration did not inject MCP into agents | Optional wrapper integration excluded; explicit public Paseo tool names remain supported |
| PDF/other arbitrary custom names without a native adapter | Native generic/unknown fallback; no output-derived identity | Legitimate unknown, not a missing known formatter |
| Media, private/unexpected metadata, oversize records | Strict projection omitted; original bounded text/placeholder remains | Deliberate safety/compatibility fallback |

The exclusions are **runtime/control integrations**, not permission to call a supported visible tool unknown. If configuration/project discovery changes or older imported history adds one of these tool names, this audit must be repeated and any reachable native structured detail must get a reviewed pure presentation projection. Do not import the Node I/O/hydration adapters into a client bundle. Compiler exact-alias and transitive purity checks remain fail-closed.
