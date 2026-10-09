import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Match Pi's AgentSession.getSessionStats() using the public extension API. */
export function buildSessionStats(ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage"> | null) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalMessages = 0;

  // Raw history is authoritative for billing, including abandoned branches and
  // compacted/context-edited messages. Never also count projected messages,
  // streaming events, or nested tool details (already included in tool usage).
  for (const entry of ctx?.sessionManager.getEntries() ?? []) {
    let usage;
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage;
    } else if (entry.type === "message") {
      totalMessages++;
      const message = entry.message;
      if (message.role === "user") userMessages++;
      else if (message.role === "assistant") {
        assistantMessages++;
        toolCalls += Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "toolCall").length : 0;
        usage = message.usage;
      } else if (message.role === "toolResult") {
        toolResults++;
        usage = message.usage;
      }
    }
    if (usage) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheWrite += usage.cacheWrite;
      cost += usage.cost.total;
    }
  }
  // reasoning and cacheWrite1h are subsets, not additional token buckets.
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    sessionFile: ctx?.sessionManager.getSessionFile(),
    sessionId: ctx?.sessionManager.getSessionId(),
    userMessages, assistantMessages, toolCalls, toolResults, totalMessages,
    tokens, cost,
    contextUsage: ctx?.getContextUsage(),
  };
}
