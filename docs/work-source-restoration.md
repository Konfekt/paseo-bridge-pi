# Work source restoration

Paseo 0.12's installed workspace panel API accepts only workspace/agent identity
and location; arbitrary panel params are not forwarded. Its supported settings
API is installation- and host-scoped, not browser/device-local. Work therefore
stores a **last explicit source restoration hint** for each host/workspace in
`work-source` settings, registered by this plugin's server entrypoint.

The hint contains host ID, workspace ID, exact agent ID and Pi session ID. It is
shared with authorized clients of that installation. A fresh contribution can
restore the latest hint written by any such client; it is not a per-browser
history. There is no synchronization of active selections: later settings
updates never switch a mounted contribution's selection, even after closing and
reopening its Work tab. Only explicitly opening Work writes a hint.

Restoration waits for settings and the initial agent snapshot, requires an
eligible non-archived Pi source in the same workspace, and checks its current
session identity. Removed, archived, dormant, wrong-workspace/provider/host or
changed-session sources never fall back to another agent. Temporarily unavailable
session status retries every five seconds. Runtime epoch changes alone do not
invalidate the hint. Removal during identity lookup and explicit source changes
invalidate the pending result. Unmount/cleanup does not erase hints or stop work.

Section, completion filter and scroll state remain contribution-local and
source-scoped, as before. Full refresh restores the source, not these UI details.
A failed settings write is retried; refreshing before the write succeeds can
still restore the previous hint. Invalid hints are ignored, not destructively
removed from the shared document.

## Live verification (after a separately authorized plugin rollout)

No deployment is part of this change. Both server registration and client bundle
must be loaded before testing; client-only hot replacement is insufficient.

1. In a desktop browser, open host H, workspace W and Pi conversation A. Record
   A's conversation title and agent ID. Ensure A's Pi session is available.
2. Click A's **Work** pill. Select **Agents**, expand a worker and verify its
   transcript. In browser Network tools, wait for the plugin settings write
   `settings.work-source.write` to succeed (and confirm the source A/session
   identity in its request). This avoids racing a pending save.
3. With Work selected, perform a full browser reload (`Ctrl+Shift+R`, or
   `Cmd+Shift+R` on macOS), not just tab close/reopen. Wait for connection and
   subscription hydration. Confirm the Work source title is A. Select **Agents**
   again and verify A's workers/transcript; the initial section may differ.
   `harness_status` requests must target A and W, never another conversation.
4. Repeat while briefly offline during reload, then reconnect. A must restore
   after inventory/session hydration; no other agent should appear meanwhile.
5. In a second browser/client on H/W, explicitly open B's Work and wait for its
   settings write. The first client's mounted Work must remain A, including
   closing/reopening that tab. A subsequent *full refresh* may restore B: this
   is the documented shared last-explicit-source hint, not live switching.
6. For invalidation, persist A again, then archive/remove A using the normal
   authorized UI and refresh. Work must remain unbound and request explicit
   selection; it must not choose B. Repeat with a source moved to another
   workspace where supported. Switching hosts/workspaces must not reuse A's hint.
7. Close/reopen Work without refreshing: source-scoped section/filter/scroll
   remain intact, with no cancel/stop/reap calls. Repeat source restoration in a
   compact browser viewport. Existing mobile React130 is a separate issue; do
   not claim this change fixes it.

The compiled Work test recreates contributions and hook state while preserving
only settings, and covers invalid identities, delayed settings/inventory,
reconnect status retry, removal during validation and an explicit-click race.
