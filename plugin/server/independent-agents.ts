import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { independentAgentOpenRpc } from "../shared/independent-agents";
import { readHarnessDescriptor } from "./harness-readonly";
import { callHarnessReadOnly, validateHarnessReadOnlyDescriptor } from "./harness-readonly-transport";
const ROOT = join(homedir(), ".pi", "paseo-bridge", "independent-conversations");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function privateDir(path: string) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) throw new Error("Private conversation directory unavailable");
}
async function readOwned(path: string, limit: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o022) || before.size > limit) throw new Error("Conversation file unavailable");
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const result = await handle.read(bytes, position, bytes.length - position, position);
      if (!result.bytesRead) throw new Error("Conversation changed while reading");
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Conversation changed while reading");
    return { bytes, stat: after };
  } finally { await handle.close(); }
}
async function snapshotMeta(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid independent history identity");
  await privateDir(ROOT); await privateDir(join(ROOT, id));
  const meta = JSON.parse((await readOwned(join(ROOT, id, "meta.json"), 16384)).bytes.toString("utf8"));
  if (meta.version !== 1 || meta.id !== id || !isAbsolute(meta.cwd) || typeof meta.title !== "string") throw new Error("Invalid independent history metadata");
  return meta;
}
function sanitize(source: any, bytes: Buffer) {
  const rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const header = rows[0];
  if (header?.type !== "session" || header.version !== 3 || typeof header.cwd !== "string" || !isAbsolute(header.cwd)
    || (source.cwd && resolve(source.cwd) !== resolve(header.cwd))) throw new Error("Unsupported source conversation");
  const entries = rows.slice(1), byId = new Map<string, any>();
  for (const row of entries) {
    if (typeof row.id !== "string" || byId.has(row.id)) throw new Error("Invalid source entry identity");
    byId.set(row.id, row);
  }
  let leaf = source.leafId;
  if (!leaf && source.assistantDigest) {
    const matches = entries.filter(e => e.type === "message" && e.message?.role === "assistant" && hash(JSON.stringify(e.message)) === source.assistantDigest);
    if (matches.length === 1) leaf = matches[0].id;
  }
  if (!leaf) {
    const parents = new Set(entries.map(e => e.parentId));
    const leaves = entries.filter(e => !parents.has(e.id));
    if (leaves.length !== 1) throw new Error("This older worker has no unambiguous saved completion branch");
    leaf = leaves[0].id;
  }
  const reversed: any[] = [], seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf) || !byId.has(leaf)) throw new Error("Invalid source branch");
    seen.add(leaf); const entry = byId.get(leaf); reversed.push(entry); leaf = entry.parentId;
  }
  let branch = reversed.reverse().filter(e => ["message", "model_change", "thinking_level_change", "compaction", "context_edit", "branch_summary"].includes(e.type)
    && (e.type !== "message" || ["user", "assistant", "toolResult"].includes(e.message?.role)));
  const pending = new Set<string>(); let batch = -1;
  for (let i = 0; i < branch.length; i++) {
    const message = branch[i].type === "message" ? branch[i].message : undefined;
    if (!message) continue;
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("Source has an unmatched tool result");
    } else {
      if (pending.size) { branch = branch.slice(0, batch); break; }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        const calls = message.content.filter((p: any) => p.type === "toolCall");
        if (calls.length) batch = i;
        for (const call of calls) { if (typeof call.id !== "string" || pending.has(call.id)) throw new Error("Invalid source tool call"); pending.add(call.id); }
      }
    }
  }
  if (pending.size) branch = branch.slice(0, batch);
  const ids = new Set(branch.map(e => e.id));
  let parentId: string | null = null;
  const clean = branch.map(e => {
    if (e.type === "compaction" && !ids.has(e.firstKeptEntryId)) throw new Error("Cannot safely copy this compaction boundary");
    const { details: _details, ...row } = e;
    const result = { ...row, parentId }; parentId = row.id; return result;
  });
  const model = [...clean].reverse().find(e => e.type === "model_change");
  const thinking = [...clean].reverse().find(e => e.type === "thinking_level_change");
  const assistant = [...clean].reverse().find(e => e.type === "message" && e.message?.role === "assistant")?.message;
  return { cwd: header.cwd, entries: clean, model: model ? `${model.provider}/${model.modelId}` : assistant?.provider && assistant?.model ? `${assistant.provider}/${assistant.model}` : undefined, thinkingLevel: thinking?.thinkingLevel };
}
export function registerIndependentAgents(server: PluginServerContext) {
  let queue: Promise<unknown> = Promise.resolve();
  const stop = server.before("agent.create", async ({ request }) => {
    const id = request.config.provider === "pi" ? request.config.providerOptions?.independentHistoryId : undefined;
    if (typeof id !== "string") return;
    const meta = await snapshotMeta(id);
    return { ...request, env: undefined, config: { ...request.config, model: meta.model,
      thinkingOptionId: meta.thinkingLevel, modeId: undefined, featureValues: undefined, systemPrompt: undefined } };
  });
  server.handle(independentAgentOpenRpc, (input, context) => {
    const operation = queue.catch(() => undefined).then(async () => {
      const parent = await context.paseo.agents.ref(input.agentId).refresh();
      if (!parent || parent.agent.workspaceId !== input.workspaceId || parent.agent.archivedAt) throw new Error("Source workspace changed");
      const descriptor = await readHarnessDescriptor(input.agentId);
      if (!validateHarnessReadOnlyDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch) throw new Error("Source Pi session changed");
      const payload = { sessionId: input.expectedSessionId, taskId: input.taskId, childId: input.childId, attempt: input.attempt, runtimeId: input.runtimeId };
      const result: any = await callHarnessReadOnly(descriptor, "subagents.independentSource", payload);
      const source = result?.source;
      if (result?.sessionId !== input.expectedSessionId || source?.taskId !== input.taskId || source.childId !== input.childId
        || source.attempt !== input.attempt || source.runtimeId !== input.runtimeId || typeof source.file !== "string") throw new Error("Source identity changed");
      await privateDir(dirname(source.file));
      const raw = await readOwned(source.file, 32 * 1024 * 1024);
      if (raw.stat.dev !== source.dev || raw.stat.ino !== source.ino || raw.stat.size !== source.size || raw.stat.mtimeMs !== source.mtimeMs) throw new Error("Source checkpoint changed");
      const data = sanitize(source, raw.bytes);
      const again: any = await callHarnessReadOnly(descriptor, "subagents.independentSource", payload);
      if (JSON.stringify(again.source) !== JSON.stringify(source)) throw new Error("Source checkpoint changed");
      const current = await readHarnessDescriptor(input.agentId);
      if (!validateHarnessReadOnlyDescriptor(current, input.agentId) || current.runtimeEpoch !== descriptor.runtimeEpoch || current.sessionId !== descriptor.sessionId) throw new Error("Source connection changed");
      const latestParent = await context.paseo.agents.ref(input.agentId).refresh();
      if (!latestParent || latestParent.agent.workspaceId !== input.workspaceId || latestParent.agent.archivedAt) throw new Error("Source workspace changed");
      const id = hash(JSON.stringify([input.agentId, input.expectedSessionId, input.taskId, input.childId, input.attempt, data]));
      await mkdir(ROOT, { recursive: true, mode: 0o700 }); await privateDir(ROOT);
      const destination = join(ROOT, id);
      try { await snapshotMeta(id); }
      catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const temporary = join(ROOT, `.new-${randomUUID()}`);
        await mkdir(temporary, { mode: 0o700 });
        try {
          const sessionId = randomUUID();
          const history = [{ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: data.cwd }, ...data.entries].map(e => JSON.stringify(e)).join("\n") + "\n";
          const title = String(source.title || "Independent conversation").trim().split(/\s+/).slice(0, 4).join(" ").slice(0, 80);
          const meta = { version: 1, id, cwd: data.cwd, model: data.model, thinkingLevel: data.thinkingLevel, sessionId, title, historySha256: hash(history) };
          await writeFile(join(temporary, "history.jsonl"), history, { mode: 0o400, flag: "wx" });
          await writeFile(join(temporary, "meta.json"), JSON.stringify(meta), { mode: 0o600, flag: "wx" });
          try { await rename(temporary, destination); } catch (e: any) { if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e; }
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      const meta = await snapshotMeta(id);
      const uuid = `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`;
      const existing = await context.paseo.agents.ref(uuid).refresh();
      if (existing) {
        if (existing.agent.labels?.["pi.independentHistory"] !== id || existing.agent.workspaceId !== input.workspaceId) throw new Error("Independent agent identity collision");
        if (existing.agent.archivedAt) throw new Error("This independent conversation is archived; open it from Paseo history");
        return { agentId: uuid };
      }
      const created = await context.paseo.workspaces.ref(input.workspaceId).agents.create({ agentId: uuid, idempotencyKey: `pi-independent-${id}`,
        title: meta.title, labels: { "pi.independentHistory": id },
        config: { provider: meta.model ? `pi/${meta.model}` : "pi/default", thinkingOptionId: meta.thinkingLevel, options: { independentHistoryId: id } } });
      return { agentId: created.id };
    });
    queue = operation;
    return operation;
  });
  return stop;
}
