import * as fs from "node:fs";
import { isHeadlessRecord, matchingRuntimeRecords, runtimeOwnerMayBeAlive } from "../shim/runtime-registry.js";

type RuntimeRecord = { kind?: string; pid: number; bridgeSocket: string; sessionFile: string; agentId?: string | null };

/** The shim running this session in the background for Paseo, if it may still be alive. */
export function liveHeadlessOwner(
  sessionFile: string,
  options: { records?: RuntimeRecord[]; ownPid?: number; mayBeAlive?: (record: RuntimeRecord) => boolean } = {},
): RuntimeRecord | undefined {
  let records: RuntimeRecord[];
  try {
    records = matchingRuntimeRecords(sessionFile, null, options.records);
  } catch {
    return undefined;
  }
  const alive = options.mayBeAlive ?? ((record: RuntimeRecord) => runtimeOwnerMayBeAlive(record));
  const ownPid = options.ownPid ?? process.pid;
  return records.find(record => isHeadlessRecord(record) && record.pid !== ownPid && alive(record));
}

/**
 * Whether the session file holds entries this Pi has not loaded, as after a
 * background Pi answered in Paseo. The file is the header line, then one
 * line per entry.
 */
export function sessionChangedOnDisk(
  sessionFile: string | undefined,
  entries: ReadonlyArray<{ id?: string }>,
): boolean {
  if (!sessionFile) return false;
  let text: string;
  try {
    text = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n").filter(line => line.trim());
  if (lines.length <= 1) return entries.length > 0;
  let lastId: unknown;
  try {
    lastId = JSON.parse(lines[lines.length - 1]).id;
  } catch {
    return true;
  }
  return lines.length - 1 !== entries.length || entries[entries.length - 1]?.id !== lastId;
}
