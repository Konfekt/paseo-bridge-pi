# Work panel lifecycle, sizing and Goals creation

## Status
Implemented locally; deployment verification pending.

## Requirements and implementation

- Goals history toggle has no count. Optional validated integer token budget
  sits beside Create; omitted/blank creation budget stays unlimited. Editing
  an unlimited goal no longer inserts a hidden 250,000-token budget.
- Work Agents uses retention, not execution: unreaped rows remain Active;
  only explicit reap moves them to Completed. Running rows use the existing
  native-adapted status ring; idle/finished unreaped rows use a green dot.
- Reap state is passed from the native producer through the read-only protocol
  and RPC schema. Native listing pages precede foreground-helper inventory;
  the overview follows bounded pages so history cannot evict active inventory.
- Preferred desktop widths use the existing host width contract on all tabs,
  including empty views. Compact layouts preserve native sheet behavior.

## Client boundary

The user restricted delivery to server and bridge changes. An unmodified
installed native/Electron Paseo 0.12 host hard-caps plugin popovers at 420px and
ignores the optional width preference. Increasing that cap requires a native
client update and is not implemented by overflowing content or replacing the
native surface. The bridge preference is ready for a host that supports it.

The requested expanded task event rendering also belongs to the host message
component. The proposed host patch was removed after that scope instruction;
server task snapshots are not falsified to imitate a renderer change.

## Verification

Source/diff review and normal package builds only. No tests, typechecks or
smoke scripts. Deployment and rendered GUI confirmation remain separate.
