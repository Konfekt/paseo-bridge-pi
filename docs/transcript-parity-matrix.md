# Work/native tool presentation parity matrix

## Meaning of parity

Supported/reachable tool presentation uses the actual existing native Pi argument/result parser, detail mapper, native error helper and public protocol display/section functions. The one reachable adapter override (subagent start / marker-less failure) uses a behavior-preserving pure extraction shared with the native adapter. No Node I/O/hydration adapter is client-imported. RN layout/expansion remain bridge adapters; this is not whole-renderer/native-device identity.

Current transport regression: **153 cases; 146 typed canonical projections; 7 explicit null/string/truly-unknown fallbacks; all62 public Paseo catalog entries**. Comparisons use the actual live/history caller's parse/result/error provenance, not just direct mapper output. Producer and bridge wire helpers are byte-identical and compared on the same corpus.

## Supported categories

| Native family | Actual managed path / implementation | Regression and browser family |
| --- | --- | --- |
| bash / shell | Same native mapper and error helper; mapped command/output/exit data | normal, failed, canceled/interrupted, running; 4.5KB command survives old argument clipping |
| read | Same native read parser/detail; mapped path/content/offset | explicit41/42 gutters; nullable options; malformed known input uses native fallback |
| write | Same native write detail | exact source content, no result-derived file identity |
| edit | Same native edit detail; exact fragments or typed result diff; shared highlighting | old/new fragments and unified diff; no fabricated positions |
| find / grep / ls | Same native search detail | native schemas/content/files |
| web search / supported aliases | Native query and result validation | explicit search leaves, namespaced aliases, q/search_term/queries/batch variants, native hit groups/annotations |
| background_job | Native custom detail + shared lifecycle formatter/error helper | all actions; exact reported start raw/typed; read-only vs managed adopt; independent stderr vs combined body |
| subagent launch / resume | Shared native adapter pure projection and normal mapper precedence | before-marker start, plain failure, managed terminal marker, synthetic historical ID; actual installed adapter9/9 reference comparison |
| subagent controls/results | Same generic mapper and canonical current task summary | list/status/output/result/prompt/resume/tasks/wait variants/reap/cancel/promote/idle_decision; displayName |
| subagent list/tasks overview | Published dfe1 canonical resolver via generic entry | latest stable task attempt; Running/Needs attention/Finished; Needs follow-up/Reported complete/verified Complete/Status unavailable |
| goal_manage / goal helpers | Same native objective/reason/evidence projection | create/update/status/pause/resume/clear; complete/blocked/wait |
| update_progress | Same native tool detail text | structured steps; separate native todo activity classified out-of-band below |
| questionnaire | Same native human question/answer detail | prompt/chosen label; pending interactive controls unchanged |
| fetch | Same native method/URL caption and prose | readable text, literal JSON not reparsed by transport |
| task_outcome | Same native outcome/acceptance/remaining projection | partial/report/next action; no unverified success inference |
| notify_parent | Same native input-message/receipt policy | queued receipt becomes real message where native does |
| sandbox controls | Same native custom-tool policy | all four existing path/read-path/domain/socket tool names |
| public Paseo catalog | Same native mapper + Paseo display/detail sections | all62 names in corpus and security whitelist; real prose/field UI family |
| truly unknown names / malformed known args | Actual native generic fallback, no guessed aliases | custom_tool, functions.read, malformed Read; reserved prototype names safely remain unclassified |

## Every Work path

| Path | Producer / consumer | Invariant / evidence |
| --- | --- | --- |
| Background history | retained-conversation → WorkerConversation | typed projection before clipping; call/result metadata by ID/name; old text retained; actual native history content/details assembly |
| Background live | worker conversation events → readonly live projection → same badge | authenticated epoch/sequence; full safe start args survive schema-added undefined end fields; metadata/text/origin selected together |
| Foreground history/live activity | headless-foreground readHistory/readMessages → Jobs foreground section → same badge/model | explicit ID/phase/status; safe arguments only by exact bound call; unknown/old opaque input kept; no JSON argument reconstruction |
| Old snapshots / bad metadata | optional fields absent/rejected | text/resultFormat unchanged; invalid metadata omitted independently; raw header prose never establishes job state |
| Error / cancellation | native error helper + authoritative lifecycle | separate stderr where native requires; no default exit0; cancellation text never proves successful outcome |
| Open child chat | existing route helper/source tuple | source session/runtime + task/child/group/attempt/runtime still checked; presentation IDs/verification labels never route authority |
| Descendant tree | reviewed b6 baseline untouched | source/parentKey, limits/pagination and after-read identity preserved |

## Browser evidence

Artifacts: `.dev/transcript-browser/`, actual candidate hashes in `build-evidence.json`, per-case results in `isolated-{history,foreground,live}-results.json`.

- Real shipped Paseo components render actual native mapper output alongside the actual emitted candidate.
- Tool fixtures are generated by production retained/live/foreground serialization against private local session fixtures; no commands or worker sockets are started by fixture generation.
- Exact read-only daemon bootstrap allowlist only. Agent sends, attention changes, heartbeats and mutations blocked. All tool timelines/bridge responses fixture-scoped.
- Wide1440 and narrow430 native/Work screenshot pairs; Read offsets/diff, literal JSON, failed stderr, current task overview, foreground and live samples.
- Open child chat uses exact fixture ownership tuple and then actual native child tab/marker; no real message send. Native route source code is unchanged.
- Source-transpiled modified compiler with installed0.13.2 dependencies is explicitly **not** a rebuilt installed compiler. Actual Hermes bytecode compilation is **not** native-device execution. Full package integration remains a later parent review gate.

## Explicit fallback / exception classifications

1. Raw-string/null results: legitimate native fallback; do not regex a job header into typed success/status. New producer can recover known typed details from historical source records when they exist.
2. Rejected/out-of-bounds/private metadata: optional projection omitted; original bounded text remains. No raw credentials/capabilities/socket/session paths/manifests are added.
3. Truly unknown foreground arguments: original opaque producer input remains visible (separate call/result when no safe binding); it is not reconstructed into JSON fields. The synthetic custom_tool literal-JSON browser sample records this input-layout exception while checking exact unchanged JSON output. Known supported tool families have strict native comparison.
4. Media: binary/unsupported blocks are placeholders, not a native image/audio service import.
5. Private app contexts/sheets/virtualization/markdown: not imported or copied; existing bounded markdown uses canonical metrics, not the private native parser.
6. Optional third-party runtime/control integrations: see `managed-adapter-scope.md` for exact registration/history evidence and exclusions. Their I/O/hydration/dialog/todo integrations are not claimed as universal extension support. The reachable subagent pure presentation override was extracted rather than evaded as unknown.

## Safety gates

Exact public compiler aliases and reviewed transitive edges; other server-package client/shared imports, traversal, ambient I/O and dynamic loading rejected. Optional transport is versioned, name-bound and bounded by16KiB/depth12/nodes1024/array64/string8KiB/strings256, with plain-data/prototype/cycle/nonfinite/accessor validation. Live pages measure the complete <=96KiB serialized page; authenticated wrong-attempt test rejects while all large typed events paginate without loss. No native app source edits or new runtime SDK module requirements.
