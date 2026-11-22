// Pure helpers for the Pi built-ins the bridge runs on Paseo's behalf.

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

type ModelLike = { provider: string; id: string; name?: string };

export function modelReference(model: ModelLike | null | undefined): string {
  return model ? `${model.provider}/${model.id}` : "none";
}

/** Match `/model` arguments: `provider/id` exactly, else a unique id or name. */
export function resolveModelArgument<T extends ModelLike>(argument: string, available: readonly T[]): T | string {
  const wanted = argument.trim();
  const lower = wanted.toLowerCase();
  const exact = available.find(model => modelReference(model).toLowerCase() === lower);
  if (exact) return exact;
  const byId = available.filter(model => model.id.toLowerCase() === lower || model.name?.toLowerCase() === lower);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return `"${wanted}" matches several models: ${byId.map(modelReference).join(", ")}. Use /model <provider/model>.`;
  const partial = available.filter(model => modelReference(model).toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return `"${wanted}" matches several models: ${partial.slice(0, 12).map(modelReference).join(", ")}${partial.length > 12 ? ", ..." : ""}. Use /model <provider/model>.`;
  }
  return `No available model matches "${wanted}". Send /model to list models with configured credentials.`;
}

export function formatModelList(available: readonly ModelLike[], current: ModelLike | undefined): string {
  const currentRef = current ? modelReference(current) : undefined;
  const lines = available.map(model => `${modelReference(model) === currentRef ? "* " : "- "}${modelReference(model)}`);
  return [`Current model: ${currentRef ?? "none"}`, "", "Available models:", ...(lines.length ? lines : ["(none with configured credentials)"]),
    "", "Switch with /model <provider/model>, or use Paseo's model picker."].join("\n");
}

export function parseThinkingLevel(argument: string): ThinkingLevelName | undefined {
  const value = argument.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevelName : undefined;
}

type Stats = {
  sessionFile?: string; sessionId?: string;
  userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
};

/** Text close to Pi's own `/session` panel. */
export function formatSessionInfo(stats: Stats, extra: { name?: string; model?: ModelLike; thinking?: string }): string {
  const number = (value: number) => value.toLocaleString("en-US");
  const prompt = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  const lines = ["Session info", ""];
  if (extra.name) lines.push(`Name: ${extra.name}`);
  lines.push(`File: ${stats.sessionFile ?? "in-memory"}`, `ID: ${stats.sessionId ?? "unknown"}`);
  if (extra.model) lines.push(`Model: ${modelReference(extra.model)}${extra.thinking ? ` (thinking ${extra.thinking})` : ""}`);
  lines.push("", "Messages",
    `Total: ${stats.totalMessages}`, `User: ${stats.userMessages}`, `Assistant: ${stats.assistantMessages}`,
    `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`, "", "Tokens", `Input: ${number(prompt)}`);
  if (prompt > 0 && (stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0)) {
    lines.push(`  Cached: ${number(stats.tokens.cacheRead)} (${((stats.tokens.cacheRead / prompt) * 100).toFixed(1)}%)`);
    lines.push(`  Uncached: ${number(stats.tokens.input + stats.tokens.cacheWrite)}`);
  }
  lines.push(`Output: ${number(stats.tokens.output)}`, `Total: ${number(stats.tokens.total)}`);
  const usage = stats.contextUsage;
  if (usage?.contextWindow) {
    const used = usage.tokens == null ? "unknown" : number(usage.tokens);
    const percent = usage.percent == null ? "" : ` (${usage.percent.toFixed(1)}%)`;
    lines.push("", `Context: ${used} of ${number(usage.contextWindow)}${percent}`);
  }
  if (stats.cost > 0) lines.push("", `Cost: $${stats.cost.toFixed(3)}`);
  return lines.join("\n");
}

/** Pi's `/export` argument: one path, optionally quoted. */
export function parsePathArgument(args: string): string | undefined {
  const value = args.trim();
  if (!value) return undefined;
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end < 0 ? undefined : value.slice(1, end);
  }
  const space = value.search(/\s/);
  return space < 0 ? value : value.slice(0, space);
}

/** Serialize the current branch as Pi's `/export file.jsonl` does. */
export function serializeBranchJsonl(
  header: { version?: number; id: string; cwd: string },
  branch: ReadonlyArray<Record<string, unknown> & { id: string }>,
  timestamp = new Date().toISOString(),
): string {
  const lines: unknown[] = [{ type: "session", ...(header.version === undefined ? {} : { version: header.version }), id: header.id, timestamp, cwd: header.cwd }];
  let parentId: string | null = null;
  for (const entry of branch) {
    lines.push({ ...entry, parentId });
    parentId = entry.id;
  }
  return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

type SessionSummary = { path: string; id: string; name?: string; modified: Date; messageCount: number; firstMessage: string };

export function formatResumeList(sessions: readonly SessionSummary[], currentFile: string | undefined): string {
  if (!sessions.length) return "No saved Pi sessions in this folder.";
  const lines = sessions.map((session, index) => {
    const title = (session.name || session.firstMessage || "(empty)").replace(/\s+/g, " ").slice(0, 70);
    const current = session.path === currentFile ? " (current)" : "";
    return `${index + 1}. ${title}${current} - ${session.messageCount} messages, ${session.modified.toISOString().slice(0, 16).replace("T", " ")} UTC, id ${session.id}`;
  });
  return ["Recent Pi sessions in this folder:", ...lines, "", "Switch the terminal with /resume <number> or /resume <id>."].join("\n");
}

export function pickResumeTarget<T extends SessionSummary>(argument: string, sessions: readonly T[]): T | string {
  const value = argument.trim();
  if (/^\d+$/.test(value)) {
    const session = sessions[Number(value) - 1];
    return session ?? `There is no session ${value}. Send /resume to list sessions.`;
  }
  const exact = sessions.filter(session => session.id === value);
  if (exact.length === 1) return exact[0];
  const matches = sessions.filter(session => session.id.startsWith(value) || session.name === value);
  if (matches.length === 1) return matches[0];
  return matches.length ? `"${value}" matches several sessions. Use its number from /resume.` : `No session matches "${value}". Send /resume to list sessions.`;
}

type BranchEntry = { type: string; message?: { role?: string; content?: unknown; stopReason?: string } };

const SIDE_CONTEXT_LIMIT = 40_000;

/** A plain-text transcript of the branch, newest context kept. */
export function sideQuestionContext(entries: readonly BranchEntry[], limit = SIDE_CONTEXT_LIMIT): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction" && typeof (entry as any).summary === "string") {
      sections.push(`Summary of earlier conversation: ${(entry as any).summary}`);
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const lines: string[] = [];
    if (typeof message.content === "string") lines.push(message.content.trim());
    else if (Array.isArray(message.content)) {
      for (const block of message.content as any[]) {
        if (block?.type === "text" && typeof block.text === "string") lines.push(block.text.trim());
        else if (block?.type === "toolCall" && typeof block.name === "string") {
          let args = "";
          try { args = JSON.stringify(block.arguments ?? {}); } catch {}
          lines.push(`Tool call: ${block.name}(${args.slice(0, 2_000)})`);
        }
      }
    }
    const text = lines.filter(Boolean).join("\n");
    if (text) sections.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const text = sections.join("\n\n");
  return text.length <= limit ? text : `[Earlier context omitted]\n${text.slice(-limit)}`;
}

export const SIDE_QUESTION_SYSTEM_PROMPT = [
  "You answer a quick side question from the user of a coding agent.",
  "Use the conversation context only as background. Answer directly and concisely.",
  "You cannot run tools or change files, and nothing you say enters the main conversation.",
  "If the context is insufficient, say what is unknown.",
].join(" ");

export function sideQuestionPrompt(question: string, context: string): string {
  return [
    "<conversation_context>", context || "No conversation yet.", "</conversation_context>",
    "", "<side_question>", question, "</side_question>",
  ].join("\n");
}

export function assistantText(message: { content?: unknown } | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return (message.content as any[])
    .filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n")
    .trim();
}
