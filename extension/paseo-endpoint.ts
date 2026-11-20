import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePaseoHome } from "../scripts/config.js";

const DEFAULT_ENDPOINT = "127.0.0.1:6767";

/** The `host:port` of a TCP target, or undefined for sockets, pipes, SSH and relay/pairing URLs. */
function tcpEndpoint(target: string): string | undefined {
  const trimmed = target.trim().replace(/^tcp:\/\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("://") || trimmed.startsWith("/") || trimmed.startsWith("\\\\")) return undefined;
  if (/^\d+$/.test(trimmed)) return `127.0.0.1:${trimmed}`;
  return /^(\[[^\]]+\]|[^:/@\s]+):\d+$/.test(trimmed) ? trimmed : undefined;
}

/** A wildcard listen address is reached through loopback. */
function dialable(endpoint: string): string {
  return endpoint.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
}

function sameLocalEndpoint(a: string, b: string): boolean {
  const key = (endpoint: string) => dialable(endpoint).toLowerCase()
    .replace(/^(127\.0\.0\.1|\[::1\]|localhost):/, "localhost:");
  return key(a) === key(b);
}

function readListen(home: string): string | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(home, "paseo.pid"), "utf8"));
    return typeof lock?.listen === "string" ? lock.listen : undefined;
  } catch {
    return undefined;
  }
}

function readLocalCredential(home: string): string | undefined {
  try {
    const token = fs.readFileSync(path.join(home, "local-credential"), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface PaseoWsTarget {
  url: string;
  /** The local daemon's credential, sent only to the endpoint its own lock file names. */
  localCredential?: string;
}

/**
 * Where the bridge opens its WebSocket: `PASEO_HOST` when it is a TCP endpoint,
 * else the TCP address the local daemon published in `$PASEO_HOME/paseo.pid`,
 * else Paseo's default. Undefined when only the CLI can reach the daemon
 * (relay/pairing URLs, SSH, or a socket-only listener).
 */
export function resolvePaseoWsTarget(env: NodeJS.ProcessEnv = process.env): PaseoWsTarget | undefined {
  const home = resolvePaseoHome(env);
  const listen = readListen(home);
  const listenEndpoint = listen === undefined ? undefined : tcpEndpoint(listen);
  const host = env.PASEO_HOST?.trim();
  let endpoint: string | undefined;
  if (host) endpoint = tcpEndpoint(host);
  else if (listen === undefined) endpoint = DEFAULT_ENDPOINT;
  else endpoint = listenEndpoint && dialable(listenEndpoint);
  if (!endpoint) return undefined;
  const local = listenEndpoint !== undefined && sameLocalEndpoint(endpoint, listenEndpoint);
  const localCredential = local ? readLocalCredential(home) : undefined;
  return { url: `ws://${endpoint}/ws`, ...(localCredential ? { localCredential } : {}) };
}
