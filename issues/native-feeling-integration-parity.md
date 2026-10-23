# Native-feeling Pi integration parity

## Status

In progress. User asked to investigate native Claude/Codex integration journeys and autonomously correct Pi bridge integration/polish mismatches. Park verified acceptance, scripted subagent workflows and profiles; those are separate backlog work.

## Outcome

**Hard constraint: never modify Paseo clients or require an app rebuild/update.** Work only in Pi, the bridge and the server, reusing existing client contracts/components and explicit compatible fallbacks.

Pi sessions should use the same existing Paseo interaction/rendering contracts as native providers where Pi can support them. Unsupported actions must not pretend to work. Preserve terminal access, literal tool results, retained worker lifecycle and established Work pill semantics. This is user-facing integration work, not a security redesign.

## Verified findings and current evidence

- Bridge auto-compaction originally reported a private boolean and acknowledged toggles without touching Pi. An offline native-Pi comparison showed initial native=false/bridge=true and after bridge-off native=true/bridge=false. Current local fix omits unknown state and explicitly rejects unavailable live control; Pi 1.4's public extension context lacks a real getter/setter.
- Manual compaction originally acknowledged success immediately, even when native Pi rejected an empty session. Local fix awaits actual onComplete/onError callbacks and returns the native result/error. Awaiting ctx.compact itself is insufficient because it returns void.
- Image attachments were retained for ordinary prompts but dropped for steer/follow_up. Local fix shares multimodal content construction across all three paths.
- Bridge remote-UI API exposed select/notify only. Local input/confirm support uses existing native Pi dialog frames; confirm replies use the native confirmed boolean. Because stock clients cannot prefill an editor, the editor adapter explicitly offers keep-existing-text or write-replacement through existing select/input dialogs, preserving existing text on keep. No claim of globally intercepting arbitrary extensions' ctx.ui calls: adoption is explicit through the existing bridge adapter.
- Questionnaire fixed choices work remotely, but allowOther/custom responses require terminal fallback. Adaptation with optional remote input support is being integrated separately in pi-agent-extensions.
- Native Pi session capabilities advertise rewind while terminal-attached bridge rejects it. Local bridge state now declares bridgeCapabilities.supportsRewindConversation=false; downstream per-session capability consumption is pending full validation. Ordinary native Pi must retain rewind support.
- Source-traced rich tool-output gap: native Claude/Codex materialize tool-result images into existing image-compatible Markdown timeline entries; Pi often retains image data inside generic tool details instead. Live/history native-shape reuse is being developed and must preserve original results.
- Source-traced structured web-search metadata gap: Pi can flatten metadata that native search details carry as webResults/annotations. Only known structured producers should be projected; arbitrary human text must not be parsed or fabricated into citations.

## Verification scope

The packaged bridge/standalone Pi 1.4 offline check passes 16 tests, including state, true compaction outcomes, canonical replay, images, awaited command feedback, Stop canceling a command wait without falsely claiming its work stopped, native dialogs and reload. Its dropped-dispatch counterfactual fails the named stats test as intended. Separate helper tests cover callback settlement, cancellation and multimodal preservation. These are not proof of mobile visual behavior.

Native-feel audits must trace actual shipped downstream patches, not assume pristine upstream gaps are still present. Canonical file/diff/shell/search/task presentation, thinking cleanup, usage/account identity and quiet turn framing already have downstream integrations. The bridge's pendingMessageCount 0/1 is not evidence of a visible queue defect: no production consumer was found in shipped Paseo. User-facing mode behavior must be checked against shipped security-mode patches rather than pristine Pi's empty mode list.

## Additional investigation: verified integration mismatches

These checks used isolated fixtures, the real Pi 1.4 executable/public SDK, and installed patched Paseo modules. No live providers, credentials or active user sessions were used. These are the original defect reproductions, not claims that all fixes have passed composed validation.

1. **Capture protocol drift drops replayed native IDs.** `emitEntryCapture` sends `{ entries }`; shipped PiRpcAgentSession.handleEntryCaptureMarker reads `{ treeEntries, contextEntries }`. An executable installed-provider probe produced a user row without messageId for the bridge payload, versus messageId=native-user-id for the current native payload. This undermines identity/anchor-dependent history integration; full downstream fork/scroll impact still requires composed tests.
2. **Visible notices vanish from replayed history.** Bridge get_messages filters raw entries to type=message instead of using Pi's session projection. A real-Pi paired test appended a display=true custom notice without a model turn: native get_messages returned one visible notice; bridge returned none. This is not intentional hiding of display=false harness messages.
3. **Context edits are not reflected in bridge replay.** Actual SDK SessionManager/buildSessionContext comparison: a replacement changes the projected user content to Corrected request while the bridge algorithm returns Original request; a null replacement omits the message natively while the bridge still returns it. Fork snapshots already use buildSessionContext, making this an internal UI/snapshot inconsistency as well.
4. **Command errors and notifications are lost on the attached channel.** Real-Pi tests showed native RPC emits an extension_error or notify frame for the fixture command; invoking the same command through the bridge still emits only on native stdout, with zero matching bridge frames. The bridge acknowledges the command. Pi's public sendUserMessage returns void and catches command errors; mocked-Promise helper tests do not prove completion/error propagation. Shipped Paseo also ignores extension_error for ordinary native Pi, whereas notify has a native timeline mapping. Error visibility needs both boundaries addressed, not just the helper.
5. **Context/cost refresh misses lifecycle transitions.** An installed PiRpcAgentSession fake-runtime probe changed model capacity from 1000 to 2000: no stats read or usage_updated event occurred, leaving the published capacity at 1000. After manual compaction changed used tokens from 800 to 50, the published usage remained 800. Failed/canceled terminal branches likewise stop polling without a final stats read (source-proven). AgentManager.lastUsage feeds the actual composer meter. Claude has explicit post-compaction usage events; model-change behavior is not claimed universally better across all providers.
6. **Manual compaction is reported as automatic.** A real-Pi positive compaction fixture supplied a synthetic summary via session_before_compact (no provider call). Native RPC emitted start/end reason=manual and result metadata. The bridge emitted start/end without reason; the shipped mapper defaults missing reason to auto. The bridge also checks the old event.entry field instead of 1.4's compactionEntry.
7. **Questionnaire UX is still flattened.** Native Claude/Codex and the upstream Pi ask_user_question adapter use structured questions/options/descriptions in one native form. Our questionnaire adapter emits sequential string selects, putting descriptions into the prompt body; the new input step restores custom answers but does not deliver the same multi-question form/review experience. This is source-confirmed interaction design, not a claim of broken existing fixed-choice answers.

### Lower-confidence or shared limitations

- Pi's history mapper omits an image-only user message and strips image blocks from mixed user messages (installed-module probe). Claude's text extraction also ignores image blocks, and the common user timeline type has no image field, so this is not presented as a uniquely broken bridge/native comparison without inspecting attachment side channels.
- Existing bridge title synchronization is one-way and can overwrite a Paseo-side rename on a full Pi restart; workspace-title coupling is also unconditional. This is a source-backed risk/design tradeoff, not yet a reproduced reconnect scenario or authorization to change prior title preferences.
- Stock native editor mapping ignores prefill. Do not change clients to implement an editor: the bridge now uses an explicit keep-or-replace select/input fallback. This is not an in-place native code editor.
- The installed watch-event detail reduces a real terminal alert to terminal/failed, dropping producer sequence, timestamp, log and acknowledgment context. Compact presentation may be intentional; do not infer a model-facing data loss or solve it by dumping opaque JSON.

## Implementation checkpoint (unpublished)

- Integrated canonical history projection, separate tree/context captures, custom notices and context edits, plus Pi 1.4 manual compaction result/reason/failure metadata.
- Final packaged bridge/native-Pi regression passes **16 tests**, including the added command-wait cancellation case. Core runtime checks pass on both Node SDK and standalone Bun with real handled/queued/started admission before generation, scoped command notifications, terminal-dialog policy, two offline model completions and zero network calls.
- All current new server patches apply in the composed production/test patch stack without fuzz. Existing baseline patches retain their existing application behavior.
- Composed server compilation and **44 focused behavior tests** pass; questionnaire producer **13/13** and compiled server adapter **11/11** pass. Coverage includes capability fallbacks, compaction outcomes, usage lifecycle, tool images, errors, human-interaction RPC lifetime and correlated native questionnaire permissions.
- Full composed validation now passes: **152 topology/integration tests**, **44 focused server tests**, **31 Codex usage tests**, compiled questionnaire/search/detail tests and server compilation. Completed-progress fixtures retain native checked rows by user choice. A real stale-child badge gap was fixed at Session.listAgentPayloads so workspace callers share exact-identity projection; the model-change fixture now provides the actual usagePoller dependency.
- Awaitable command dispatch is integrated across prompt/steer/follow-up. Actual admission receipts replace false ordinary-prompt acknowledgements. Stop cancels the command wait with an explicit unknown-work-outcome error and seals subsequent controller notifications; arbitrary command work can remain in the terminal.
- Questionnaire dialogs use private tool/phase correlation and existing native question forms. Other uses a separate input step, literal values and provenance survive, disconnection falls back to terminal, and losing/closed permission cards are cleaned up.
- No parity changes have been published or deployed yet. Deployment is now explicitly authorized; existing retained Pi processes will not be terminated and need a deliberate restart to acquire new runtime APIs. Native-device visuals remain unverified.

## Required completion evidence

- Review and compose isolated worker diffs; run actual behavior tests, not only patch dry-runs or source regex assertions.
- Verify actual installed provider capability snapshots, native-compatible dialog/question results, and rich-result live/history mapping with deterministic isolated fixtures; no real credentials, provider requests or live-session mutations for testing.
- Run bridge/plugin and consumer host-parity checks, publish related commits and shared pins, and validate any authorized host activation. Server changes do not update an installed native application binary; document device/rendering limitations honestly.
- Keep issues with missing evidence open rather than claiming full native parity from a green helper suite.
