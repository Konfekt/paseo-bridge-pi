# Independent conversations from completed native workers

## Status

Implemented and deployed locally for user review; uncommitted. Matebook system: `/nix/store/gcgp6nc97nkbvl00kxcw920vfmy3pbi4-nixos-system-matebook-26.05.20260916.4c78701`.

The active parent Pi session needs `/remote-reload` after the current assistant turn to publish the new source endpoint. The user requested no test suites or extra validation runs. Only the required Nix production build/deployment was run; actual first-message/device behavior has not been exercised by the assistant.

## Behavior

- Completed agent rows create/reuse a normal native Paseo conversation, not a plugin transcript panel. A transient public plugin screen uses native navigation to return to the workspace and open the agent tab.
- Opening prepares an immutable sanitized history snapshot and a dormant agent record. Pi session creation/resume returns a dormant adapter before starting the runtime or preparing MCP resources.
- History and runtime metadata are served from the snapshot. Runtime-bound plugin pills are hidden while dormant.
- The first explicit prompt materializes a fresh writable Pi session and launches it using the new agent's normal tmux/permission/tool context. The source worker and its transcript remain unchanged. No parent relationship is assigned.
- Source export is parent/session/child/attempt/runtime bound, completed-only, and private to the daemon. Future completion reports record the exact leaf. Legacy records require a uniquely matched completed assistant or an unambiguous branch.
- Only conversation/context/model/thinking entries are retained. Worker system prompts, extension custom state, custom control messages, labels, lineage, approvals, Goal state, and worker environment are not copied. Incomplete trailing tool exchanges are trimmed. A fresh system reminder makes old worker obligations historical rather than active authority.
- New session naming uses the snapshot title without generating a title from the old task or renaming the parent workspace.
- Opening is serialized/idempotent by source checkpoint. Startup is single-flight, and interruption/close before dispatch prevents sending. Known pre-dispatch errors reject so native draft restoration applies. An unresolved previous startup without an owned runtime record refuses to launch a replacement.
- After activation, persistence uses the new session's native handle. Later restoration delegates to the normal Pi session while preserving the independent-origin marker/reminder. No original worker handle is resumed.

## First user-click correction

The initial click reached agent creation but failed with `agent.create hooks cannot change the workspace directory`. The plugin hook no longer changes cwd. The Pi-specific native creation path now resolves cwd from the private snapshot before normalization and tmux launch context creation. Generic lifecycle-hook restrictions remain intact. The downstream patch is applied after tmux topology patches so its manager changes compose correctly.

## Implementation

- Core: `subagent/tui-native.ts`, `subagent/tui-worker-extension.ts`, `subagent/index.ts`, `shared/harness-readonly.ts`.
- Bridge: private source dispatch in `extension/index.ts`; `plugin/server/independent-agents.ts`; typed public open RPC; native navigation in `plugin/client/agent-conversation.tsx`.
- Nix: `packages/paseo/pi-independent-session.ts` and its provider/normalization patch.

Original helper panes/chats remain retained during harness recovery/user review. Terminal `/btw` integration remains a separate unfinished item.
