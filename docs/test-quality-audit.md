# Focused bridge check audit

## Concrete gaps at initial audit

- `flake.nix` previously exported packages but no checks. Building the source
  package did not exercise configuration or runtime helpers.
- `package.json`'s `test` glob runs `test/*.test.ts`, not `plugin/test/`;
  `test:plugin` is a separate entrypoint. Compiled plugin tests (for example
  `compiled-server.test.mjs`) skip without `PASEO_PLUGIN_COMPILER`, and
  `account-controls-core-contract.test.ts` skips without
  `PI_AGENT_EXTENSIONS_SOURCE`. A green default test command does not establish
  those integrations passed.
- `test/model-sync.test.ts`'s final test matches source text in `index.ts` for
  model/thinking RPC wiring; `test/session-stats.test.ts`'s final test does the
  same for stats dispatch. Their earlier helper tests are useful, but these
  string assertions cannot establish that commands actually reach the helpers.
- `test/idle-preflight.test.ts` locally reimplements `isPiRequestAbortError`.
  Its classification assertion does not test the production classifier.
- `plugin/test/compiled-server.test.mjs` uses a hand-built
  `foregroundService.execute` that immediately accepts mutations. This is
  appropriate transport isolation, but cannot establish real worker stop or
  permission settlement. Do not count it as that lifecycle coverage.

## Prioritized regression coverage

`nix build .#checks.x86_64-linux.pure-helpers --no-link -L` (substitute the
host system) runs a bounded, hermetic suite and evaluates negative Nix
configuration assertions. `nix flake check` discovers the same check.

1. Settings persistence: actual `extension/bridge-settings.ts` with temporary
   files; canonical/legacy precedence, no credential migration, malformed-file
   non-overwrite, private atomic replacement, immutable files/directories,
   dangling and managed symlinks, serialization-failure cleanup, and environment
   precedence/legacy opt-out semantics.
2. Abort settlement: actual production helper; a closed lifetime must neither
   dispatch abort nor acknowledge a successor's idle state, missing context and
   synchronous dispatch failures stay failures, and a timeout cannot falsely
   acknowledge settlement.
3. Idle handshake: malformed and throwing capabilities fail closed; late
   continuation after abort never sends; listeners are cleaned up on all tested
   settlement paths; downstream dispatch failures propagate with no retry.
4. Packaging/configuration: inspect the built package's advertised paths and
   execute the generated RPC wrapper against a controlled executable peer.
   Verify argument quoting, explicit-extension de-duplication and no discovery,
   environment values/quoting, plus rejection of unsafe/relative configuration.

Only the external SDK's `getAgentDir()` lookup is replaced by a test loader;
settings logic is imported unchanged. It does not validate SDK directory
resolution itself. No package install, provider, account, active session, tmux,
network RPC, or service restart is needed. Production sources were unchanged:
these regressions did not reveal a production bug.

## Mutation-sensitivity evidence

Two actual production-module mutants were run on disposable copies of
`extension/`, `test/` and `package.json`, using Node 24 from
`nix shell --inputs-from . nixpkgs#nodejs_24`. Each copied suite ran via
`node --experimental-strip-types --test <suite>`; both returned exit 1. The
copies were deleted afterward; neither checkout's production sources changed.

- **Early abort settlement:** replaced the first
  `if (context.isIdle()) return;` in `extension/abort-dispatch.ts` with an
  unconditional `return;`. `test/abort-dispatch.test.ts` failed 3 of 5 tests:
  “waits for Pi to become idle after fire-and-forget abort” failed
  `assert.ok(polls >= 2)`; “lifetime invalidation never dispatches or
  acknowledges a successor session” failed with **Missing expected rejection**
  (`/context closed/`); “fails instead of falsely acknowledging an unsettled
  abort” failed with **Missing expected rejection**
  (`/Pi did not become idle after cancellation/`).
- **Environment overrides persisted preference:** replaced `isAutoEnabled()`'s
  boolean preference/fallback expression with just
  `environmentBoolean("PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT")`.
  `test/bridge-settings.test.ts` failed 1 of 6 tests:
  “environment parsing and persisted precedence preserve legacy opt-out
  presence semantics” reported **true !== false** at the persisted
  `auto: false` assertion (line 108). The other five settings tests passed,
  showing the failure was specific to precedence rather than fixture setup.

## Additional boundary coverage

The copied `isPiRequestAbortError` classifier was removed from the preflight
suite: duplicating a private upstream function is not proof of compatibility.
That integration still needs a check against the actual Paseo provider.

The default abort-wait contract now advances a controlled clock beyond the old
short deadline while the context remains busy, then settles it. This proves
slow cleanup stays pending without a wall-clock sleep. The hermetic runner has
a 30-second test deadline to bound failures, not to define product timeouts.

## Native artifact/RPC follow-up

The source-regex model/thinking/stats wiring assertions were removed. The
reusable `nix/native-rpc-check.nix { pkgs; piPackage; src; }` constructor loads the
BUILT bridge package into the caller's actual standalone Pi. Its offline tests
exercise Unix-socket state/commands/stats, thinking changes, repeated same-model
echoes, valid model changes, invalid-model non-effects, and reload preserving the
fixture's process/session/socket. Stats are compared to Pi's native RPC result.
An ordinary prompt is consumed by a real SDK input hook before any model turn;
the receipt proves `source: extension` and absent streaming behavior.

A writable artifact copy drops `get_session_stats` dispatch. The same integration
must fail its named stats case with `Unknown command: get_session_stats`; arbitrary
startup/import errors are not counted as a killed mutant. The previously skipped
native-reload test is now required in this constructor, uses the artifact and an
allowlisted temporary environment, and fails if its executable is not supplied.
Native files use `.integration.ts`, outside the default unit-test glob;
`test:native` is explicit. No silent optional-integration skips are added to a
passing unit count. Reload occurs only in the disposable fixture process.

The consumer exports this as `checks.x86_64-linux.pi-bridge-native-rpc`; keeping
Pi selection at the constructor boundary avoids pinning a second Pi in this
reusable bridge repository.

## Remaining gaps

Neither focused check is the full plugin/compiler suite, live-provider suite,
native-client rendering test or every `index.ts` command. Streaming prompt/Stop
and full Goal/provider/session composition need separate integration coverage.
Race injection between mutable-file checks and rename, OS-level permission/ACL
failures, and actual SDK path resolution remain outside the pure-helper check.
Its abort polling uses an injected scheduler rather than real tool shutdown.
Other advertised systems need native builders to establish execution results.
