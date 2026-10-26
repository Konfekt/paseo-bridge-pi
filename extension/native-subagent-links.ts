import * as path from "node:path";

type RecordValue = Record<string, any>;
export type NativeSessionSource = {
  taskId: string; childId: string; groupId: string; attempt: number; runtimeId: string | null;
  reaped?: boolean; sessionFile?: string; title?: string; status: "running" | "completed" | "failed" | "cancelled" | "lost";
};
export type ResolveNativeSession = (input: { taskId: string; childId: string; attempt: number }) => Promise<NativeSessionSource | undefined>;
type Link = { id: string; agent: string; task: string; taskId: string; childId: string; attempt: number; retries: number; nextRead: number; source?: NativeSessionSource; sent?: string };
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const statuses = new Set(["running", "completed", "failed", "cancelled", "lost"]);
export const NATIVE_SUBAGENTS_MARKER = "PI_NATIVE_SUBAGENTS_V1:";

/** Private bridge-to-daemon linkage. Never adds session paths to Pi's model history. */
export class NativeSubagentLinks {
  private readonly starts = new Map<string, { agent: string; task: string }>();
  private readonly links = new Map<string, Link>();
  private flushing = false;
  private flushDone: Promise<void> | null = null;
  private deliveryEpoch = 0;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private start(id: unknown, args: unknown): void {
    if (!text(id, 1024) || !record(args) || args.operation !== undefined || args.action !== undefined
      || !text(args.agent, 256) || !args.agent.trim() || !text(args.task, 32768) || !args.task.trim()) return;
    if (this.starts.size >= 512 && !this.starts.has(id)) this.starts.delete(this.starts.keys().next().value!);
    this.starts.set(id, { agent: args.agent.trim(), task: args.task.trim().slice(0, 1024).trim() });
  }

  private result(id: unknown, result: unknown): void {
    if (!text(id, 1024) || !record(result) || !record(result.details)) return;
    const start = this.starts.get(id);
    if (!start) return;
    const d = result.details;
    // Foreground events have already been projected to one child. Background
    // starts can retain their original single-child native group envelope.
    const c = d.task_id ? d : d.tui_subagent === true && record(d.group) && Array.isArray(d.group.children) && d.group.children.length === 1 ? d.group.children[0] : undefined;
    if (!record(c) || !/^subagent-task-[0-9a-f]{24}$/.test(c.task_id ?? "")
      || !/^subagent-child-[0-9a-f]{24}$/.test(c.child_id ?? "") || !Number.isSafeInteger(c.attempt) || c.attempt < 1) return;
    const previous = this.links.get(id);
    if (previous && (previous.taskId !== c.task_id || previous.childId !== c.child_id || previous.attempt !== c.attempt)) return;
    if (!previous && this.links.size >= 256) this.links.delete(this.links.keys().next().value!);
    this.links.set(id, previous ?? { id, ...start, taskId: c.task_id, childId: c.child_id, attempt: c.attempt, retries: 0, nextRead: 0 });
  }

  private readonly reapedBindings: Array<{ taskId: string; childId: string; attempt: number; runtimeId: string }> = [];
  reapedBindingKeys(): string[] { return this.reapedBindings.map(binding => JSON.stringify(binding)); }

  reap(input: { taskId: string; childId: string; attempt: number; runtimeId: string }): void {
    if (!text(input.taskId, 64) || !/^subagent-task-[0-9a-f]{24}$/.test(input.taskId)
      || !text(input.childId, 64) || !/^subagent-child-[0-9a-f]{24}$/.test(input.childId)
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !text(input.runtimeId, 256)) return;
    if (!this.reapedBindings.some(binding => binding.taskId === input.taskId && binding.childId === input.childId
      && binding.attempt === input.attempt && binding.runtimeId === input.runtimeId)) this.reapedBindings.push({ ...input });
  }

  observe(event: any): void {
    if (event?.toolName !== "subagent") return;
    if (event.type === "tool_execution_start") this.start(event.toolCallId, event.args);
    if (event.type === "tool_execution_update") this.result(event.toolCallId, event.partialResult);
    if (event.type === "tool_execution_end") this.result(event.toolCallId, event.result);
  }

  seed(messages: any[]): void {
    for (const m of messages) {
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) if (c?.type === "toolCall" && c.name === "subagent") this.start(c.id, c.arguments);
      } else if (m?.role === "toolResult" && m.toolName === "subagent") this.result(m.toolCallId, m);
    }
  }

  clear(): void { this.deliveryEpoch++; this.starts.clear(); this.links.clear(); this.reapedBindings.length = 0; }

  resetDelivery(): void {
    this.deliveryEpoch++;
    for (const link of this.links.values()) { delete link.source; delete link.sent; link.retries = 0; link.nextRead = 0; }
  }

  private async source(link: Link, resolve: ResolveNativeSession, force = false): Promise<NativeSessionSource | undefined> {
    if (!force && this.now() < link.nextRead) return link.source;
    // Keep retrying with capped backoff: a slow manifest/permission transition
    // must not strand a task as running until the next bridge reload.
    link.nextRead = this.now() + Math.min(10000, 1000 * 2 ** Math.min(link.retries, 4));
    try {
      const s = await resolve({ taskId: link.taskId, childId: link.childId, attempt: link.attempt });
      if (!s || s.taskId !== link.taskId || s.childId !== link.childId || s.attempt !== link.attempt
        || !text(s.groupId, 128) || !(s.runtimeId === null || text(s.runtimeId, 256))
        || (s.sessionFile !== undefined && (!text(s.sessionFile, 4096) || !path.isAbsolute(s.sessionFile) || s.sessionFile.includes("\0"))) || !statuses.has(s.status)) {
        delete link.source; link.retries = Math.min(10, link.retries + 1); return undefined;
      }
      // A terminal status can be authoritative before the session file is
      // readable. Don't pin this partial snapshot: retry until a file appears.
      link.source = s;
      link.retries = s.sessionFile || s.status === "running" ? 0 : Math.min(10, link.retries + 1);
      return s;
    } catch { delete link.source; link.retries = Math.min(10, link.retries + 1); return undefined; }
  }

  async enrichHistory(messages: any[], resolve: ResolveNativeSession): Promise<any[]> {
    this.seed(messages);
    const output = [];
    for (const m of messages) {
      const link = m?.role === "toolResult" ? this.links.get(m.toolCallId) : undefined;
      const source = link ? await this.source(link, resolve, true) : undefined;
      if (!source?.sessionFile || !Array.isArray(m.details?.results) || m.details.results.length !== 1) { output.push(m); continue; }
      output.push({ ...m, details: { ...m.details, results: [{ ...m.details.results[0], sessionFile: source.sessionFile }] } });
    }
    return output;
  }

  async notifications(resolve: ResolveNativeSession): Promise<string[]> {
    if (this.flushing) {
      await this.flushDone;
      return this.notifications(resolve);
    }
    this.flushing = true;
    let finishFlush!: () => void;
    this.flushDone = new Promise(resolve => { finishFlush = resolve; });
    const epoch = this.deliveryEpoch;
    try {
      const bindings: any[] = [];
      const delivered: Array<[Link, string]> = [];
      for (const link of this.links.values()) {
        const s = await this.source(link, resolve);
        if (!s) continue;
        const reaped = s.reaped === true || (s.runtimeId !== null && this.reapedBindings.some(binding => binding.taskId === s.taskId && binding.childId === s.childId
          && binding.attempt === s.attempt && binding.runtimeId === s.runtimeId));
        const binding = { id: link.id, taskId: s.taskId, childId: s.childId, attempt: s.attempt, runtimeId: s.runtimeId,
          ...(s.sessionFile ? { sessionFile: s.sessionFile } : {}), status: s.status, ...(reaped ? { hidden: true } : {}), agent: link.agent, task: text(s.title, 80) && s.title.trim() === s.title && !/[\p{Cc}\p{Cf}]/u.test(s.title) && s.title.split(/\s+/u).length <= 4 ? s.title : link.task };
        const fingerprint = JSON.stringify(binding);
        if (link.sent === fingerprint) continue;
        bindings.push(binding); delivered.push([link, fingerprint]);
      }
      if (epoch !== this.deliveryEpoch) return [];
      for (const [link, fingerprint] of delivered) link.sent = fingerprint;
      // A large session must not create an unbounded notification frame.
      const messages: string[] = [];
      let batch: any[] = [];
      for (const binding of bindings) {
        const candidate = [...batch, binding];
        if ((candidate.length > 128 || Buffer.byteLength(JSON.stringify({ version: 1, bindings: candidate })) > 48 * 1024) && batch.length) {
          messages.push(NATIVE_SUBAGENTS_MARKER + JSON.stringify({ version: 1, bindings: batch })); batch = [];
        }
        batch.push(binding);
      }
      if (batch.length) messages.push(NATIVE_SUBAGENTS_MARKER + JSON.stringify({ version: 1, bindings: batch }));
      return messages;
    } finally {
      this.flushing = false;
      this.flushDone = null;
      finishFlush();
    }
  }
}
