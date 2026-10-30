import assert from "node:assert/strict";
import test from "node:test";

import { coordinateMirroredSelect } from "../extension/mirrored-select.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("remote selection wins and dismisses the terminal prompt", async () => {
  const remote = deferred<string | undefined>();
  let localAborted = false;
  const result = coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        localAborted = true;
        resolve(undefined);
      }, { once: true });
    }),
    resolveLocal: async () => assert.fail("terminal response must not be submitted"),
  });

  remote.resolve("Allow once");
  assert.equal(await result, "Allow once");
  assert.equal(localAborted, true);
});

test("a concurrent Paseo response remains authoritative", async () => {
  const remote = deferred<string | undefined>();
  const daemon = deferred<unknown>();
  const resultPromise = coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: async () => "Allow once",
    resolveLocal: () => daemon.promise,
  });

  await Promise.resolve();
  remote.resolve("Deny once");
  assert.equal(await resultPromise, "Deny once");
});

test("failed submission does not apply the local choice; a later backend cancellation settles it", async () => {
  const remote = deferred<string | undefined>();
  let completed = false;
  const result = coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: async () => undefined,
    resolveLocal: async () => null,
  });
  void result.then(() => { completed = true; }, () => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  remote.resolve(undefined);
  assert.equal(await result, undefined);
});
