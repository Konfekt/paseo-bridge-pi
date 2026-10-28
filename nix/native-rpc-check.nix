# Offline integration against the caller's pinned, unwrapped Pi package. No
# extra Pi flake input and no installed user wrapper/configuration are involved.
{
  pkgs,
  piPackage,
  src ? ../.,
}:
let
  bridgePackage = pkgs.callPackage ./package.nix { inherit src; };
in
pkgs.runCommand "paseo-bridge-pi-native-rpc"
  {
    nativeBuildInputs = [
      pkgs.nodejs_24
      pkgs.gnugrep
    ];
  }
  ''
    export HOME="$TMPDIR/check-home"
    mkdir -p "$HOME" "$out"
    cp -r ${src} source
    chmod -R u+w source
    cd source
    export BRIDGE_NATIVE_PI=${piPackage}/bin/pi
    export TEST_PI_BIN=${piPackage}/bin/pi
    # Load the installed artifact (including its helper/JSON closure), not the
    # checkout. Fixtures/tests alone run from src.
    export BRIDGE_NATIVE_EXTENSION=${bridgePackage}/extension/index.ts
    node --experimental-strip-types --test --test-reporter=tap \
      --test-timeout=45000 test/*.integration.ts > "$out/native.tap" 2>&1 || {
        cat "$out/native.tap"
        exit 1
      }
    cat "$out/native.tap"

    # Mutate only a disposable copy of the ACTUAL extension; there is no fake
    # dispatcher in this fixture. The same executable/test must detect lost RPC
    # routing, not just pass when implementation text happens to match a regex.
    cp -r ${bridgePackage} mutant-package
    chmod -R u+w mutant-package
    node --input-type=module <<'JS'
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = 'mutant-package/extension/index.ts';
    const source = readFileSync(file, 'utf8');
    const original = 'case "get_session_stats":';
    if (source.split(original).length !== 2) throw new Error('Mutation target not unique');
    writeFileSync(file, source.replace(original, 'case "mutant_dropped_session_stats":'));
    JS
    export BRIDGE_NATIVE_EXTENSION="$PWD/mutant-package/extension/index.ts"
    if node --experimental-strip-types --test --test-reporter=tap \
      --test-timeout=45000 test/*.integration.ts > "$out/mutant.tap" 2>&1; then
      cat "$out/mutant.tap"
      echo 'ERROR: dropped get_session_stats routing survived behavioral tests' >&2
      exit 1
    fi
    # Do not count arbitrary startup/fixture failures as mutation evidence.
    grep -E 'not ok [0-9]+ - native bridge routes session stats' "$out/mutant.tap" || { cat "$out/mutant.tap"; exit 1; }
    grep -F 'Unknown command: get_session_stats' "$out/mutant.tap" || { cat "$out/mutant.tap"; exit 1; }
    # Owned command support must be actual functionality, not merely a test
    # accepting stock rejection. Remove both direct management entry points.
    cp -r ${bridgePackage} owned-mutant-package
    chmod -R u+w owned-mutant-package
    node --input-type=module <<'JS'
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = 'owned-mutant-package/extension/index.ts';
    const source = readFileSync(file, 'utf8');
    const original = 'if (await handleBridgeManagement(cmd, send)) return;';
    if (source.split(original).length !== 3) throw new Error('Owned mutation targets changed');
    writeFileSync(file, source.replaceAll(original, '/* mutant: owned management route dropped */'));
    JS
    export BRIDGE_NATIVE_EXTENSION="$PWD/owned-mutant-package/extension/index.ts"
    if node --experimental-strip-types --test --test-reporter=tap \
      --test-timeout=45000 test/*.integration.ts > "$out/owned-mutant.tap" 2>&1; then
      cat "$out/owned-mutant.tap"
      echo 'ERROR: dropped owned management routes survived behavioral tests' >&2
      exit 1
    fi
    grep -E 'not ok [0-9]+ - bridge-owned management executes on stock and reports real failures' "$out/owned-mutant.tap" || { cat "$out/owned-mutant.tap"; exit 1; }
    # Stock delivery must never masquerade as a completed third-party command.
    cp -r ${bridgePackage} acceptance-mutant-package
    chmod -R u+w acceptance-mutant-package
    node --input-type=module <<'JS'
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = 'acceptance-mutant-package/extension/prompt-dispatch.ts';
    const source = readFileSync(file, 'utf8');
    const original = 'throw new Error("This Pi runtime cannot report extension command outcomes. This command has no explicit remote route; use the terminal.");';
    if (source.split(original).length !== 2) throw new Error('Acceptance mutation target changed');
    writeFileSync(file, source.replace(original, 'pi.sendUserMessage(content); return { agentInvoked: false };'));
    JS
    export BRIDGE_NATIVE_EXTENSION="$PWD/acceptance-mutant-package/extension/index.ts"
    if node --experimental-strip-types --test --test-reporter=tap \
      --test-timeout=45000 test/*.integration.ts > "$out/acceptance-mutant.tap" 2>&1; then
      # An outcome-capable peer does not enter the mutated stock-only branch.
      if ! grep -F '"commandOutcomes":true' "$out/acceptance-mutant.tap" >/dev/null; then
        cat "$out/acceptance-mutant.tap"
        echo 'ERROR: false third-party completion survived stock behavioral tests' >&2
        exit 1
      fi
    else
      grep -E 'not ok [0-9]+ - third-party commands: real outcomes where supported, explicit no-effects rejection on stock' "$out/acceptance-mutant.tap" || { cat "$out/acceptance-mutant.tap"; exit 1; }
    fi
    echo 'Production integration passed; applicable dispatch, owned-route and false-completion mutants failed their named cases.'
  ''
