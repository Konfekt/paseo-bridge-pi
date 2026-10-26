import { constants, lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolveExactChildRuntime } from "../shared/existing-child-identity";
function processStartToken(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch { return null; }
}
import { readHarnessDescriptor } from "./harness-readonly";
import { validateHarnessReadOnlyDescriptor } from "./harness-readonly-transport";

/** Read registry metadata only, never child history or mutable snapshot files. */
export async function readPrivateChildRuntimes() {
  const directory = join(homedir(), ".pi", "paseo-bridge", "runtimes");
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error("Child runtime registry is unavailable.");
  const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
  if (names.length > 4096) throw new Error("Child runtime registry exceeds its read budget.");
  const records = [];
  for (const name of names) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("Unsafe child runtime record.");
      const value = JSON.parse(await file.readFile("utf8"));
      const after = await file.stat();
      if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Child runtime record changed while reading.");
      records.push(value);
    } finally { await file.close(); }
  }
  return records;
}

export function createExistingChildRouteHandler(deps = {
  readDescriptor: readHarnessDescriptor,
  resolve: async (sessionId: string, input: any) => resolveExactChildRuntime(sessionId, input, await readPrivateChildRuntimes(), processStartToken),
}) {
  return async (input: any, context: any) => {
    const assertParent = async () => {
      const parent = await context.paseo.agents.ref(input.agentId).refresh();
      if (parent?.agent.id !== input.agentId || parent.agent.workspaceId !== input.workspaceId) throw new Error("The source agent workspace changed.");
      const descriptor = await deps.readDescriptor(input.agentId);
      if (!validateHarnessReadOnlyDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch) throw new Error("The source session changed; reopen its Agents list.");
      return descriptor;
    };
    const pinned = await assertParent();
    const route = await deps.resolve(input.expectedSessionId, input);
    if (!route.available || !route.agentId || !route.workspaceId) throw new Error(route.reason ?? "No existing live child conversation is registered.");
    const child = await context.paseo.agents.ref(route.agentId).refresh();
    if (child?.agent.id !== route.agentId || child.agent.workspaceId !== route.workspaceId || child.agent.provider !== "pi" || child.agent.archivedAt) throw new Error("The registered child conversation is no longer available.");
    const current = await assertParent();
    const checked = await deps.resolve(input.expectedSessionId, input);
    if (current.capability !== pinned.capability || current.socketPath !== pinned.socketPath || !checked.available || checked.agentId !== route.agentId || checked.workspaceId !== route.workspaceId) throw new Error("Child conversation ownership changed while resolving its route.");
    return { agentId: route.agentId, workspaceId: route.workspaceId };
  };
}
