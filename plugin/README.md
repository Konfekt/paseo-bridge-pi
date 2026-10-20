# Paseo Pi controls

A Paseo plugin with account controls, agent-specific permission controls, a foreground-task composer popover, and Activity / Jobs / Pi subagents views. Install from this repository with:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The pill is registered against each non-archived Pi agent's `agentId` and workspace. The daemon and Pi must run as the same Unix user; Windows daemon hosts are not supported. Changes apply to the selected agent and its children; underlying authorization and sandbox policy remain mandatory. Its label reports `On`, `Off`, `unavailable`, or a checking state. The popover reads current state, disables controls when state is stale/unavailable or an operation is busy, and sends explicit `enabled: true` or `enabled: false` requests. Status failures never imply a mode. No model prompt, chat message, abort, or slash command is used.

## Worktree and Goal

The agent-bound **Workflows** composer pill opens native Goal controls and Git worktree management. A session-owned private service adapts the candidate engines. Creation/removal/pruning retain exact previews and revalidation; removal also refuses a worktree used by another open Paseo agent. Open new workspace uses explicit, idempotent native workspace creation in the parent project and preserves the original Pi conversation. It does not infer tmux workspace identity from cwd.

Goal starts only after explicit confirmation showing model, workspace and limits. The panel supports pause, resume/wake, objective/budget updates and clear, and retains completed-goal evidence. Default limits are three automatic responses, two repeated no-progress runs and a 250k main-session token budget; the final request may exceed that budget. Existing tool permissions and model/idle-guard policies remain in force. Goal state persists in Pi; setup dialogs are invalidated on reload.

No raw chat-command injection is used for these controls. Requests and dialog responses bind session/runtime/service/operation identities and idempotency keys. Lost replies lock mutations until refreshed state is reviewed. The native iOS visual/gesture check remains a user-review step.

## BTW side conversations

The agent-bound **BTW** composer pill opens a native workspace panel. It adapts the candidate's side-thread engine through a separate private controller: model/context selection, streamed text, follow-ups, Stop, explicit deletion, and temporary reconnectable history. Main conversation state is untouched. **Copy answer** uses the native client clipboard for explicit paste; the public plugin SDK cannot directly edit the main draft.

Pi must have the companion `btw` extension loaded. Reloading Pi clears side history and cancels owned responses. Session/runtime/service identity and idempotency checks protect every mutation; uncertain delivery requires a fresh status review before another action. The default side model is separate from the main model, with no fallback. Native iOS verification is pending user review.

## Accounts header popover

The Activity dashboard contains only Progress, Cache, and Recent responses. Account switching and login status live in the native workspace **Accounts** header popover. Select a Pi session explicitly when a workspace has multiple Pi agents; a sole session is selected initially, and an established selection is never silently retargeted if that session disappears or restarts. Switching between Pi's built-in login and existing named accounts requires confirmation and is enabled only when the account service reports Pi idle. Add named accounts using Pi `/accounts`; credentials are never copied or entered in Paseo. The optional official link is labeled **Open usage settings**; it is a settings link, not a usage report or quota.

Account controls use a separate capability-authenticated private socket and descriptor, bound to agent, session, bridge runtime epoch, and account-service epoch. The read-only harness API is unchanged. Switch requests include a stable request ID and expected selection revision; uncertain outcomes are not automatically replayed, and require refreshing status before another action. Missing account-controls service is shown as unavailable.

Provider usage stays in Paseo's native Usage panels, with their existing sources and account associations. Named-account quota integration requires a verified account-matched source; this change adds none.

## Activity: progress, cache, and recent responses

The **Activity** pill opens one agent-bound dashboard with the three diagnostics visible together. It uses Paseo's native SettingsSection/SettingsCard surfaces, themed React Native meters, and expandable details; there are no feature tabs.

- **Progress:** completed/total meter, active and blocked steps first, and an expansion for the full list. Blocked steps retain their own label and color.
- **Cache:** observed hit-rate meter and a compact input/cost summary. Cache details expand in place for weighted totals, request gaps, estimates, and recent hit-rate bars. Unknown metrics remain unavailable.
- **Recent responses:** five compact model/time/duration/cost rows with tap-to-expand token details, plus an expansion for more responses and tool timing. The source retains up to 50 stamp records. Original conversation bubbles remain unchanged.

Requires the companion Pi `stamp`, `progress`, and `cache-hit-monitor` extensions and a bridge reload. Each feature can be enabled independently; missing features show unavailable. Snapshots use the existing authenticated private read-only harness transport, bind host/agent/workspace/session/runtime, validate output schemas, and reject stale results. No credentials, response IDs, raw diagnostic text, message content, tool arguments, or tool output are exported. Progress display text is bounded without changing saved state.

The shared Nix Paseo package also maps successful `update_progress` version-5 results into native conversation task cards, including persisted-history replay. Paseo's task protocol has no blocked state, so blocked rows retain `completed: false` and an explicit “Blocked” label. Failed, running, malformed, and unsupported results retain ordinary tool rendering. This mapper needs the corresponding daemon package update; the iOS application uses its existing task-card renderer.

The panel polls its independent sections every five seconds only while mounted and supports one manual/reconnect refresh. It has no mutations, approvals, or prompt dispatch. Use Pi's `/stamp`, `/progress`, and `/cache-hit-monitor` commands for terminal settings/display; the mobile panel does not parse terminal widgets.

Compiled-plugin rendering and transport tests are automated; **native iOS visual/interaction verification is pending deployment**.

## Interactive foreground tasks

The **Foreground** composer pill opens a temporary, agent-bound popover (anchored surface on wide layouts; bottom sheet on compact layouts). Its closed-state label reports running work, pending questions/permissions, or finished tasks. It lists foreground helpers owned directly by the selected parent Pi session, streams their conversation, and supports explicit user prompts, individual permission/questionnaire answers, and Stop. Closing or dismissing the surface only hides it; it does not stop the helper. Unsent prompt drafts and questionnaire selections are retained client-side across close/reopen for that host, agent, parent session, and task.

Foreground control requires the companion `pi-agent-extensions` runtime to publish `__paeForegroundTasksV1` protocol 1. Control uses its own private socket and capability descriptor; it is not added to the read-only Jobs/Subagents transport or permission-mode operator. Requests bind the Paseo agent, parent session, bridge runtime epoch, service epoch, and task/worker epoch. Request IDs are stable across uncertain outcomes; nothing is automatically replayed or approved. Stale worker interactions are disabled. Background workers may start foreground helpers, but those helpers do not delegate, so the view is the parent's direct task list rather than a recursive tree. No tmux object, Paseo agent, workspace tab, or nested Modal is created for this UI.

## Read-only Jobs and Pi subagents

The **Jobs** and **Pi subagents** pills open agent-bound panels. These request data only while open, refresh every five seconds, and offer manual refresh. The first version shows up to 50 direct session-owned jobs or native tasks, not a recursive tree.

- Jobs: status, elapsed time, observation-only labels, and bounded output.
- Native subagents: status, attempt, bounded answer-only report, and **Open child chat** only when the backend verifies an exact live Paseo runtime match.
- Retained data is labeled as a snapshot, with its update time when known. Reloading or replacing the Pi session invalidates an old detail selection.
- No cancel, reap, resume, messaging, or notification-consumption actions are exposed. Job output does not mark a completion notification read.

Both the bridge and `pi-agent-extensions` must include the version-1 read-only harness API and be loaded in the Pi session. This read-only interface does not require permission-gate authority. Unsupported backends (including AgentSH-backed task snapshots in this first version) show an explanation rather than pretending their task list is empty. To inspect a child's local jobs, open that child's Pi chat and its Jobs view.

## Trust scope

The plugin is designed for the trusted-local Paseo model, including ordinary guard-only Pi sessions. The operator capability and descriptor remain in daemon-side plugin code and are never returned to the frontend. The descriptor is read from `~/.pi/paseo-bridge/operators/<sha256(agentId)>.json`; the private local socket receives the v1 `permission_gate_mode` protocol and binds requests/responses to agent, session, and runtime epoch. Filesystem owner/mode checks are defense in depth, not protection against malicious same-UID shell code in an unsafe Pi session. Do not treat this as a sandbox bypass or as protection from malicious same-user processes.

The plugin uses only Paseo host libraries at runtime and has no preparation/build step or added runtime dependencies. Pure wire, socket, UI-state, and lifecycle tests can be run with:

```sh
node --experimental-strip-types --test plugin/test/*.test.ts
```

Compile using the installed Paseo 0.10 host compiler (no package installation):

```sh
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node plugin/test/compile.mjs
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node --experimental-strip-types --test plugin/test/compiled-*.test.mjs
```

The tests verify closed-state task attention, explicit permission/questionnaire decisions, stale worker disabling, retained drafts/answers, close/reopen mutation locking, and private transport identity races. Compiled-bundle tests exercise the Paseo SDK plugin backend against the real private bridge socket. An opt-in integration test launches real `HeadlessForegroundManager` workers under Pi's RPC runtime and drives permission, questionnaire, fresh prompt, and Stop through that socket using a temporary deterministic provider (no model/network calls):

```sh
PAE_FOREGROUND_RUNTIME_TEST=1 \
PI_AGENT_EXTENSIONS_SOURCE=/path/to/pi-agent-extensions \
PI_TUI_TEST_PI=/nix/store/.../raw-pi/bin/pi \
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node --experimental-strip-types --test plugin/test/compiled-foreground-tasks-real-runtime.test.mjs
```

Set `PI_TUI_TEST_PI` to the raw immutable Pi executable, not an AgentSH/permission-gate wrapper. The test never inherits or reuses `PI_TUI_WORKER_LAUNCHER`; it explicitly binds the selected raw test Pi to the native `none` launch mode. The test creates no tmux panes, Paseo agents, workspaces, or persistent configuration. Its external runtime source is read-only.

Automated validation passes with Paseo 0.11.4. Mobile/desktop visual confirmation after installation remains pending. Full plugin TypeScript declaration checking is not yet configured (the installed server SDK omits frontend type dependencies). Bridge TypeScript checking is covered by the root `npm run typecheck`.
