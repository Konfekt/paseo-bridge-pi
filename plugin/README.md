# Paseo Pi controls

A Paseo plugin with account controls, native access modes, a Work composer indicator that opens a native workspace tab, and cache metrics in native context/usage. Install from this repository with:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The pill is registered against each non-archived Pi agent's `agentId` and workspace. The daemon and Pi must run as the same Unix user; Windows daemon hosts are not supported. Changes apply to the selected agent and its children; underlying authorization and sandbox policy remain mandatory. Its label reports `On`, `Off`, `unavailable`, or a checking state. The popover reads current state, disables controls when state is stale/unavailable or an operation is busy, and sends explicit `enabled: true` or `enabled: false` requests. Status failures never imply a mode. No model prompt, chat message, abort, or slash command is used.

## Access mode and composer layout

On the patched Paseo server, Pi's existing native mode selector beside thinking displays **Dangerous ask** (approval prompts on) or **Full access** (approval prompts off). Reads reflect the authoritative permission-gate service; only an explicit selection changes it. Existing sandbox/authorization policy stays active. Session/runtime-bound writes are read back, and unsupported runtimes expose no native modes. A renamed plugin control remains as a fallback until the active Pi bridge is reloaded; it disappears once both native modes are advertised.

**Work** groups Jobs (foreground and background), Agents, Worktrees, and Goals. Its badge prioritizes active subagents (`n subagents`), then active foreground/background jobs (`m jobs`), otherwise `Work`. Active work uses Paseo's dot-and-ring appearance, blue while running and amber/yellow when the displayed category needs attention. The adapted ring geometry and animation are attributed in `client/work-status-ring.tsx`, with the upstream Apache-2.0 license in `client/PASEO-LICENSE`. Completed items do not count, and foreground helpers are not counted again as subagents. The native n/m checklist is unchanged and remains separate. Hidden registrations do not poll. The separate Goal pill and Activity entry are removed; btw and Accounts retain their existing placement. Clicking the pill opens or focuses the workspace's native **Work** tab. The tab follows the conversation whose pill was clicked, keeps its selected section and scroll position, and uses the available workspace area instead of a popover width. Closing it closes only the view, never the underlying work.

### Work tab regression

```sh
PASEO_PLUGIN_COMPILER=/path/to/paseo/lib/paseo/packages/server/dist/server/server/plugins/compiler.js \
  npm run test:work-tab
```

This compiles the production plugin with the host compiler and exercises native panel registration, source changes, view-state restoration, delayed scroll hydration, stale navigation and UI-only unmounts. Missing compiler dependencies fail rather than silently skip. The test does not replace a visual client review.

## Worktree and Goal

**Work → Goals** shows the model-managed objective, linked progress checklist and waiting/blocker reason. Goals are described in chat; no mandatory creation form remains. Pause/Resume, Edit, Clear and Limits support intervention. Explicit subtask entry is available while paused and idle, and resets with goal/session identity. Completed and cleared goals appear in a Completed list, while clearing does not count as successful completion. The existing Goal engine and `update_progress` remain the sources of truth, not a new task database. **Work → Worktrees** groups branches by repository, with worker associations and changed-file counts. Non-Git workspace folders discover child repositories up to two directory levels down; their main checkouts are labeled and cannot be removed. Inside a repository, the existing additional-worktree view is retained. Session-owned trees outside the workspace remain included. Scans skip hidden/dependency/build directories and directory symlinks, and are bounded/cached rather than recursive on every refresh. A container with no repositories gets a neutral empty state, not a `git rev-parse` failure. Selected details provide Open and guarded Remove actions rather than generic creation forms. Models create isolated native Linux workers with the `subagent` worktree option: clean checkouts may omit the changes choice; staged, unstaged or untracked changes require explicit include/exclude, and ignored files are not copied. Worktrees survive completion/reap. Removal preserves branches and requires exact confirmation, a clean tree, no attached worker and no other open Paseo agent using it. Open reuses an explicit existing workspace ID when available; otherwise it creates one in the parent project without moving the original conversation.

Goal starts only after explicit confirmation showing model, workspace and limits. The panel supports pause, resume/wake, objective/budget updates and clear, and retains completed/cleared goal history. Default limits are three automatic responses and two repeated no-progress runs. Token budgets are unlimited unless explicitly requested; the final request may exceed an explicit token budget. Existing tool permissions and model/idle-guard policies remain in force. Goal state persists in Pi; setup dialogs are invalidated on reload.

No raw chat-command injection is used for these controls. Requests and dialog responses bind session/runtime/service/operation identities and idempotency keys. Lost replies lock mutations until refreshed state is reviewed. The native iOS visual/gesture check remains a user-review step.

## BTW side conversations

The agent-bound **BTW** composer pill opens a native workspace panel. It adapts the candidate's side-thread engine through a separate private controller: model/context selection, streamed text, follow-ups, Stop, explicit deletion, and temporary reconnectable history. Main conversation state is untouched. **Copy answer** uses the native client clipboard for explicit paste; the public plugin SDK cannot directly edit the main draft.

Pi must have the companion `btw` extension loaded. Reloading Pi clears side history and cancels owned responses. Session/runtime/service identity and idempotency checks protect every mutation; uncertain delivery requires a fresh status review before another action. The default side model is separate from the main model, with no fallback. Native iOS verification is pending user review.

## Accounts header popover

Account switching and login status live in the native workspace **Accounts** header popover. Select a Pi session explicitly when a workspace has multiple Pi agents; a sole session is selected initially, and an established selection is never silently retargeted if that session disappears or restarts. Switching between Pi's built-in login and existing named accounts requires confirmation and is enabled only when the account service reports Pi idle. Add named accounts using Pi `/accounts`; credentials are never copied or entered in Paseo. The optional official link is labeled **Open usage settings**; it is a settings link, not a usage report or quota.

Account controls use a separate capability-authenticated private socket and descriptor, bound to agent, session, bridge runtime epoch, and account-service epoch. The read-only harness API is unchanged. Switch requests include a stable request ID and expected selection revision; uncertain outcomes are not automatically replayed, and require refreshing status before another action. Missing account-controls service is shown as unavailable.

Provider usage stays in Paseo's native context/usage cards. Native `openai` can use the candidate's experimental **Codex companion** path: keep inference on `openai`, sign `openai-codex` into the same account/workspace, and explicitly set `openaiUseCodexUsage: true` in `pi-usage.json`. It defaults off; matebook enables it declaratively after the user's matching companion login. Disabling is read at the next discovery/request guard.

The companion Pi service publishes a noncredential native-registration hash, bound to its actual agent directory and supported model/auth configuration. The daemon matches the native grant, rechecks both grants and runtime identity, then sends **only the companion credential** to the fixed ChatGPT app-list and usage endpoints. A complete bounded app list must contain exactly one matching native client registration before plan usage is read. Matching registration is not independent proof of the same user/workspace: the user's same-account setup remains required. No native tokens are sent to the legacy quota endpoint, and no credentials are switched or refreshed by usage reads.

Plan percentages/reset windows, app reset windows and a separately labeled app allowance cap are shown. App percentages are intentionally hidden, and Codex-specific limits are not substituted for native app limits. The source is labeled experimental; it uses undocumented endpoints. The adapted candidate mapping retains MIT provenance in `server/PI-USAGE-LICENSE`. Compatible legacy named grants retain their guarded quota path. API keys, pending/mismatched bindings, disabled companion usage and invalid registration responses fail closed. Reload Pi once after installing the new registration-proof service; this enables companion routing, not direct-token quota access.

## Native context/usage

Activity is no longer registered as a pill or panel. Completed-prompt history has no replacement in normal UI. Task progress stays in the native checklist and Work → Goals, not in another diagnostics dashboard. Existing observability data and terminal commands remain available.

The context-window details show **Prompt cache** through Paseo's native usage cards: last-request and session hit rates, cached/fresh input tokens, and cache-write tokens when applicable. These are details, not quota windows, and stay out of the global account list. Unknown hit rates are reported as unknown, not zero. Local cache reads do not call the provider, and a five-second sample locator avoids inheriting the quota source's five-minute report cache.

Requires Paseo 0.11.4 with the companion session-usage patch and Pi's `cache-hit-monitor` extension. Cache snapshots use the authenticated private read-only harness transport, bind the agent/session/runtime, validate output schemas, and reject stale results. No credentials, message content, tool arguments or tool output are exported.

The shared Nix Paseo package also maps successful `update_progress` version-5 results into native conversation task cards, including persisted-history replay. Paseo's task protocol has no blocked state, so blocked rows retain `completed: false` and an explicit “Blocked” label. Failed, running, malformed, and unsupported results retain ordinary tool rendering. This mapper needs the corresponding daemon package update; the iOS application uses its existing task-card renderer.

Native context usage refreshes while mounted; provider quota retains its own cache and native manual refresh. Context cards are delivered together in deterministic source/account order, so OpenAI stays above Prompt cache regardless of request completion timing. Plan labels and relative resets use native window rendering; duplicate app reset windows are omitted, and distinct app resets use native rows without exposing app percentages. There are no mutations, approvals or prompt dispatch from usage cards. Use Pi's `/stamp`, `/progress`, and `/cache-hit-monitor` commands for terminal settings/display. Live visual and identity confirmation remains a user-review step.

## Interactive foreground tasks

The **Jobs** section in **Work** stacks Foreground and Background active jobs, or shows `No active jobs`. A bottom `Completed` button switches to retained, non-active jobs. Category tabs, Close/Refresh buttons, the background-panel shortcut, and background snapshot timestamps are omitted; status and output refresh automatically. It lists foreground helpers owned directly by the selected parent Pi session, streams their conversation, and supports explicit user prompts, individual permission/questionnaire answers, and Stop. Closing or dismissing the surface only hides it; it does not stop the helper. Unsent prompt drafts and questionnaire selections are retained client-side across close/reopen for that host, agent, parent session, and task.

Foreground control requires the companion `pi-agent-extensions` runtime to publish `__paeForegroundTasksV1` protocol 1. Control uses its own private socket and capability descriptor; it is not added to the read-only Jobs/Subagents transport or permission-mode operator. Requests bind the Paseo agent, parent session, bridge runtime epoch, service epoch, and task/worker epoch. Request IDs are stable across uncertain outcomes; nothing is automatically replayed or approved. Stale worker interactions are disabled. Background workers may start foreground helpers, but those helpers do not delegate, so the view is the parent's direct task list rather than a recursive tree. No per-helper tmux object, Paseo agent, workspace tab, or nested Modal is created for this UI.

## Read-only Jobs and Pi subagents

The Jobs and Agents views in **Work** are agent-bound, with compact active lists and a native Completed toggle. Worktrees provide an inventory and native workspace navigation directly from the Work tab. Data refreshes automatically while its view is mounted. Jobs and Agents show up to 50 direct session-owned records, not a recursive tree.

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
