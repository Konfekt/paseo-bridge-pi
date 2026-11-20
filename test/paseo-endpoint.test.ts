import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePaseoHome } from "../scripts/config.js";
import { resolvePaseoWsTarget } from "../extension/paseo-endpoint.ts";

const credential = "A".repeat(43);

function home(listen?: string, token: string | null = credential): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-endpoint-"));
  if (listen !== undefined) fs.writeFileSync(path.join(dir, "paseo.pid"), JSON.stringify({ pid: 1, listen }));
  if (token !== null) fs.writeFileSync(path.join(dir, "local-credential"), `${token}\n`);
  return dir;
}

test("PASEO_HOME expands ~ like Paseo", () => {
  assert.equal(resolvePaseoHome({}), path.join(os.homedir(), ".paseo"));
  assert.equal(resolvePaseoHome({ PASEO_HOME: "~/alt" }), path.join(os.homedir(), "alt"));
  assert.equal(resolvePaseoHome({ PASEO_HOME: "/srv/paseo" }), "/srv/paseo");
});

test("without PASEO_HOST the bridge dials the local daemon's published listener", () => {
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: home("127.0.0.1:7788") }), {
    url: "ws://127.0.0.1:7788/ws",
    localCredential: credential,
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: home("0.0.0.0:7000") }), {
    url: "ws://127.0.0.1:7000/ws",
    localCredential: credential,
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: home("tcp://[::]:7001") }), {
    url: "ws://[::1]:7001/ws",
    localCredential: credential,
  });
});

test("without a published listener the default endpoint is used", () => {
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: home(undefined) }), { url: "ws://127.0.0.1:6767/ws" });
});

test("socket-only daemons, relay and SSH targets are left to the CLI", () => {
  assert.equal(resolvePaseoWsTarget({ PASEO_HOME: home("/run/paseo.sock") }), undefined);
  assert.equal(resolvePaseoWsTarget({ PASEO_HOME: home("unix:///run/paseo.sock") }), undefined);
  const local = home("127.0.0.1:6767");
  for (const host of ["https://app.paseo.sh/#offer=x", "ssh://me@box", "unix:///run/paseo.sock", "/run/paseo.sock"]) {
    assert.equal(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: host }), undefined, host);
  }
});

test("the local credential goes only to the endpoint the lock names", () => {
  const local = home("127.0.0.1:6767");
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: "localhost:6767" }), {
    url: "ws://localhost:6767/ws",
    localCredential: credential,
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: "tcp://127.0.0.1:6767" }), {
    url: "ws://127.0.0.1:6767/ws",
    localCredential: credential,
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: "6767" }), {
    url: "ws://127.0.0.1:6767/ws",
    localCredential: credential,
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: "other-box:6767" }), {
    url: "ws://other-box:6767/ws",
  });
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: local, PASEO_HOST: "127.0.0.1:7000" }), {
    url: "ws://127.0.0.1:7000/ws",
  });
});

test("malformed credentials are ignored", () => {
  assert.deepEqual(resolvePaseoWsTarget({ PASEO_HOME: home("127.0.0.1:6767", "short") }), {
    url: "ws://127.0.0.1:6767/ws",
  });
});
