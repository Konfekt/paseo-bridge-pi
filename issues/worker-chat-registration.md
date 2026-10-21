# Worker chat registration recovery

## Status

Deployed locally for review; uncommitted. Matebook system: `/nix/store/pf4wz2hhkkizdwdrx7r31vvylfk35h9y-nixos-system-matebook-26.05.20260916.4c78701`.

## Findings and repair

Tmux workspaces existed while three workers had no Paseo agent ID or pane agent tag. One registered research worker had a blank (`-`) title. Daemon logs contained pre-allocation projected-workspace import failures. The bridge's five-attempt limit could permanently latch registration off after such failures.

The existing idle worker sessions were named using `/name` and reconnected using `/paseo-bridge connect`; they were not replaced or restarted. Paseo listed all four after deployment:

- Provider design — `ff300261-85d1-45fe-805f-08c083ac5bf2`
- Copy design — `0f154acd-adce-4a1e-8956-70d4e82ca7bb`
- Pi provider — `97778354-3e8d-4944-b12f-8b33a37398db`
- Independent snapshots — `4a360971-15cc-4ec3-a8fb-8f046a123769`

Known pre-allocation workspace failures now continue retrying at a capped 60-second interval after the initial backoff. Retry classification is narrowed to explicit missing projected-workspace/project errors, not arbitrary error text containing “workspace”. Ambiguous failures are not blindly retried.

New native TUI workers receive a short session name from their launch name before import. Existing session names are retained; headless helpers do not inherit a parent's name. This also avoids depending on generated titles for worker chats.

## Boundaries

No test suites or extra validation scripts were run. Evidence is actual reconnection, successful deployment, active service, and the live Paseo agent list. Client-device visibility remains user-reviewed.

The independent-conversation implementation was paused during this repair, with its client draft preserved at `/tmp/paseo-harness-recovery.9pBweW`. It has since been completed and deployed separately; see `independent-conversations.md`. Existing worker panes are retained during recovery so the user can inspect their chats; do not reap them merely as routine cleanup while diagnosing visibility.
