import { processStartToken, readRuntimeRecords } from "../shim/runtime-registry.js";
import { resolveExactChildRuntime, type ExactChildIdentity, type PaseoRuntimeLink } from "../plugin/shared/existing-child-identity.ts";
export type { ExactChildIdentity, PaseoRuntimeLink } from "../plugin/shared/existing-child-identity.ts";

export function resolvePaseoChildRuntimeLink(ownerSessionId: string, identity: ExactChildIdentity,
  records: any[] = readRuntimeRecords(), tokenForPid: (pid: number) => string | null = processStartToken): PaseoRuntimeLink {
  return resolveExactChildRuntime(ownerSessionId, identity, records, tokenForPid);
}
