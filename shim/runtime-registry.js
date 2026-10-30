import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function runtimeRegistryDirectory() {
  return path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes");
}

export function readRuntimeRecords(directory = runtimeRegistryDirectory()) {
  let files;
  try { files = fs.readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return files.filter(file => file.endsWith(".json")).map(file => {
    // Records are atomically published. Corruption is not evidence that an
    // owner has exited: fail closed rather than starting another writer.
    const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid Pi runtime registry record");
    }
    if (typeof record.sessionFile !== "string" || !record.sessionFile) {
      throw new Error("Invalid Pi runtime registry record: session file is required");
    }
    if (!Number.isSafeInteger(record.pid) || record.pid < 1) {
      throw new Error("Invalid Pi runtime registry record: process ID is required");
    }
    if (typeof record.bridgeSocket !== "string" || !record.bridgeSocket) {
      throw new Error("Invalid Pi runtime registry record: bridge socket is required");
    }
    if (record.agentId != null && (typeof record.agentId !== "string" || !record.agentId)) {
      throw new Error("Invalid Pi runtime registry record: agent ID must be nonempty");
    }
    if (record.processStartToken != null && !/^[a-f0-9-]+:\d+$/.test(record.processStartToken)) {
      throw new Error("Invalid Pi runtime registry record: malformed process start token");
    }
    return record;
  });
}

export function processStartToken(pid = process.pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${boot}:${fields[19]}`;
  } catch { return null; }
}

export function runtimeOwnerMayBeAlive(record, options = {}) {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return true;
  const kill = options.kill ?? process.kill;
  try { kill(record.pid, 0); }
  catch (error) { return error.code !== "ESRCH"; }
  const startToken = (options.processStartToken ?? processStartToken)(record.pid);
  // Old records and platforms without start tokens remain conservative.
  return !record.processStartToken || !startToken || record.processStartToken === startToken;
}

export function matchingRuntimeRecords(sessionFile, agentId, records = readRuntimeRecords()) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return records.filter(record =>
    (agentId && record.agentId === agentId)
    || (sessionFile && typeof record.sessionFile === "string"
      && normalize(record.sessionFile) === normalize(sessionFile)));
}

export function assertNoLiveRuntimeOwner(sessionFile, options = {}) {
  const records = matchingRuntimeRecords(sessionFile, options.agentId, options.records);
  const owner = records.find(record => record.pid !== options.ignorePid
    && runtimeOwnerMayBeAlive(record, options));
  if (owner) throw new Error(`Pi session already has a live or unresolved runtime owner (PID ${owner.pid}); bridge unavailable. Refusing to launch a second Pi. Reconnect to the existing runtime first.`);
}
