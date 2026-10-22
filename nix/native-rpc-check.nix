# Offline integration against the caller's pinned, unwrapped Pi package. No
# extra Pi flake input and no installed user wrapper/configuration are involved.
{ pkgs, piPackage, src ? ../. }:
pkgs.runCommand "paseo-bridge-pi-native-rpc" {
  nativeBuildInputs = [ pkgs.nodejs_24 ];
} ''
  export HOME="$TMPDIR/check-home"
  mkdir -p "$HOME" "$out"
  cp -r ${src} source
  chmod -R u+w source
  cd source
  export BRIDGE_NATIVE_PI=${piPackage}/bin/pi
  node --experimental-strip-types --test --test-reporter=tap \
    --test-timeout=45000 test/native-bridge-rpc.test.ts > "$out/native.tap" 2>&1 || {
      cat "$out/native.tap"
      exit 1
    }
  cat "$out/native.tap"

  # Mutate only a disposable copy of the ACTUAL extension; there is no fake
  # dispatcher in this fixture. The same executable/test must detect lost RPC
  # routing, not just pass when implementation text happens to match a regex.
  cp -r extension mutant-extension
  node --input-type=module <<'JS'
  import { readFileSync, writeFileSync } from 'node:fs';
  const file = 'mutant-extension/index.ts';
  const source = readFileSync(file, 'utf8');
  const original = 'case "get_session_stats":';
  if (source.split(original).length !== 2) throw new Error('Mutation target not unique');
  writeFileSync(file, source.replace(original, 'case "mutant_dropped_session_stats":'));
  JS
  export BRIDGE_NATIVE_EXTENSION="$PWD/mutant-extension/index.ts"
  if node --experimental-strip-types --test --test-reporter=tap \
    --test-timeout=45000 test/native-bridge-rpc.test.ts > "$out/mutant.tap" 2>&1; then
    cat "$out/mutant.tap"
    echo 'ERROR: dropped get_session_stats routing survived behavioral tests' >&2
    exit 1
  fi
  # Do not count arbitrary startup/fixture failures as mutation evidence.
  grep -F 'not ok 2 - native bridge routes session stats' "$out/mutant.tap"
  grep -F 'Unknown command: get_session_stats' "$out/mutant.tap"
  echo 'Production integration passed; dropped-dispatch mutant failed its named case.'
''
