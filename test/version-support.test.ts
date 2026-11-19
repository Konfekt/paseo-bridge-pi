import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { paseoVersionWarning, piVersionWarning, PI_TESTED_VERSION, runningPiVersion, versionWarning, warnOnce } from "../extension/version-support.ts";

test("verified releases are silent; newer, pre-release and older ones warn", () => {
  for (const version of ["1.0.0", "1.5.2", "1.5.9", undefined, null, "", "garbage"])
    assert.equal(piVersionWarning(version as string | undefined), undefined, String(version));
  assert.match(piVersionWarning("1.6.0")!, /^Pi 1\.6\.0 is newer than the tested range \(1\.0\.0 to 1\.5\.x\); continuing tentatively/);
  assert.match(piVersionWarning("2.0.0-beta.1")!, /is a pre-release/);
  assert.match(piVersionWarning("0.9.0")!, /older than the supported minimum 1\.0\.0/);
  assert.match(paseoVersionWarning("0.17.0-beta.1")!, /^Paseo 0\.17\.0-beta\.1 is a pre-release \(tested range 0\.13\.0 to 0\.16\.x\)/);
  assert.match(paseoVersionWarning("0.17.0")!, /^Paseo 0\.17\.0 is newer than the tested range \(0\.13\.0 to 0\.16\.x\); continuing tentatively/);
  for (const version of ["0.13.0", "0.15.4", "0.16.2", "0.16.9"]) assert.equal(paseoVersionWarning(version), undefined, version);
  assert.match(versionWarning("X", "v3.0.0", "1.0.0", "2.1.0")!, /newer/);
});

test("each warning is reported once per process", () => {
  const seen: string[] = [];
  assert.equal(warnOnce("unique warning for test", message => seen.push(message)), true);
  assert.equal(warnOnce("unique warning for test", message => seen.push(message)), false);
  assert.equal(warnOnce(undefined, message => seen.push(message)), false);
  assert.deepEqual(seen, ["unique warning for test"]);
});

test("the running Pi version is read, and the tested version matches the pinned devDependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.devDependencies["@earendil-works/pi-coding-agent"], PI_TESTED_VERSION);
  assert.equal(runningPiVersion(), PI_TESTED_VERSION);
});
