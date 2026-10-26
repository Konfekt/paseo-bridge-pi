/** Bounded, presentation-only decoding. Never infer tool identity from output. */
export const TOOL_DETAIL_BYTES = 24 * 1024;
const MAX_DEPTH = 6;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function bounded(text: string): string {
  // UTF-8, including astral characters; do not split a code point.
  const marker = "\n[truncated]";
  let bytes = 0, end = 0, safeEnd = 0;
  for (const char of text) {
    bytes += char.codePointAt(0)! > 0xffff ? 4 : char.charCodeAt(0) > 0x7ff ? 3 : char.charCodeAt(0) > 0x7f ? 2 : 1;
    if (bytes > TOOL_DETAIL_BYTES) return text.slice(0, safeEnd) + marker;
    end += char.length;
    if (bytes <= TOOL_DETAIL_BYTES - marker.length) safeEnd = end;
  }
  return text;
}
function readable(value: unknown): string {
  if (typeof value === "string") return bounded(value);
  if (value === undefined) return "";
  try { return bounded(JSON.stringify(value, null, 2) ?? ""); } catch { return "[unavailable tool output]"; }
}
function contentBlock(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "tool_result" || value.type === "toolResult") return "content" in value;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "audio") return typeof value.data === "string" && typeof value.mimeType === "string";
  if (value.type === "image") return typeof value.data === "string" && typeof value.mimeType === "string";
  if (value.type === "image_url") return typeof value.image_url === "string" || (record(value.image_url) && typeof value.image_url.url === "string");
  if (value.type === "resource") return record(value.resource) && typeof value.resource.uri === "string";
  if (value.type === "resource_link") return typeof value.uri === "string" && typeof value.name === "string";
  // Future binary content blocks are transport-shaped, but never render payloads.
  return typeof value.type === "string" && typeof value.data === "string" && typeof value.mimeType === "string" &&
    Object.keys(value).every(key => ["type", "data", "mimeType", "_meta", "annotations"].includes(key));
}
function envelope(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (value.type === "tool_result" || value.type === "toolResult") return "content" in value;
  // A JSON file having a `content` array is not by itself an MCP result.
  if (Object.keys(value).some(key => !["content", "structuredContent", "isError", "_meta", "details"].includes(key))) return false;
  if (value.isError !== undefined && typeof value.isError !== "boolean") return false;
  const structured = typeof value.structuredContent === "string" || record(value.structuredContent);
  const blocks = value.content;
  const transportHint = structured || value.isError === true || (Array.isArray(blocks) && blocks.some(contentBlock));
  // Establish transport identity independently of sibling validity. Once a
  // recognized MCP block/explicit marker exists, malformed siblings must not
  // force a raw-wrapper fallback (which could expose binary media payloads).
  return Array.isArray(blocks) ? transportHint : structured;
}
/** Exact producer carrier only; never attempt to reconstruct partial JSON. */
export function isLegacyTruncatedResult(value: unknown): value is { truncated: true; preview: string } {
  return record(value) && value.truncated === true && typeof value.preview === "string" && value.normalized !== true && Object.keys(value).every(key => ["truncated", "preview"].includes(key));
}
export function literalToolResult(value: unknown, format?: "text"): unknown {
  return format === "text" && typeof value === "string" ? { content: [{ type: "text", text: value }] } : value;
}
export function preferredToolResult(live: unknown, retained: unknown, liveFormat?: "text", retainedFormat?: "text"): unknown {
  return isLegacyTruncatedResult(live) && retained !== undefined && retained !== ""
    ? literalToolResult(retained, retainedFormat)
    : live !== undefined && live !== null ? literalToolResult(live, liveFormat) : literalToolResult(retained, retainedFormat);
}
/** Parse only transport positions. Text blocks are terminal even when they contain JSON. */
export function normalizeToolResult(input: unknown): string {
  function decode(value: unknown, depth: number): string {
    if (depth >= MAX_DEPTH) return "[tool output nesting limit]";
    if (typeof value === "string") {
      const limited = bounded(value);
      if (limited !== value) {
        // Oversized encoded transports cannot be safely inspected within this
        // budget. Do not expose a binary payload merely because parsing stopped.
        const first = value.trimStart()[0];
        return first === "{" || first === "\"" ? "[structured tool output truncated]" : limited;
      }
      // Peel wire string quoting only if it leads to a recognized envelope.
      // A plain/JSON file string remains byte-for-byte unchanged otherwise.
      let candidate: unknown = value;
      for (let level = depth + 1; level < MAX_DEPTH && typeof candidate === "string"; level++) {
        try { candidate = JSON.parse(candidate); } catch { break; }
        if (envelope(candidate)) return decode(candidate, level);
      }
      return value;
    }
    if (record(value) && value.truncated === true && typeof value.preview === "string" && Object.keys(value).every(key => ["truncated", "preview", "normalized"].includes(key))) {
      if (value.normalized === true) return bounded(value.preview + "\n[truncated]");
      // Legacy serialization may have cut INSIDE a JSON string. Only a fully
      // parseable known envelope can be decoded; otherwise refresh retained source.
      try { const parsed = JSON.parse(value.preview); if (envelope(parsed)) return bounded(decode(parsed, depth + 1) + "\n[truncated]"); } catch {}
      return "[structured tool output truncated; refresh source]";
    }
    if (!envelope(value)) return readable(value);
    let output = "";
    if (Array.isArray(value.content)) {
      output = value.content.slice(0, 128).map(block => {
        if (!record(block)) return "[unsupported content]";
        if (block.type === "text" && typeof block.text === "string") return bounded(block.text);
        if (block.type === "audio") return `[audio${typeof block.mimeType === "string" ? `: ${bounded(block.mimeType)}` : ""}]`;
        if (block.type === "image" || block.type === "image_url") return `[image${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}]`;
        if (envelope(block)) return decode(block, depth + 1);
        // Do not print arbitrary image/base64 payloads from unsupported content blocks.
        return `[unsupported content${typeof block.type === "string" ? `: ${bounded(block.type)}` : ""}]`;
      }).join("\n");
      if (value.content.length > 128) output += "\n[truncated]";
    } else if ("content" in value) output = decode(value.content, depth + 1);
    if (!output && value.structuredContent !== undefined) {
      // structuredContent is the fallback, not a second copy of text content.
      output = envelope(value.structuredContent) ? decode(value.structuredContent, depth + 1) : readable(value.structuredContent);
    }
    return bounded((value.isError === true ? "[tool error]\n" : "") + output);
  }
  return decode(input, 0);
}
/** End events omit arguments; retain the matching start's authoritative arguments. */
export function mergeLiveToolEvents<T extends { toolCallId: string; arguments?: unknown }>(events: readonly T[]): T[] {
  const tools = new Map<string, T>();
  for (const event of events) {
    const previous = tools.get(event.toolCallId);
    tools.set(event.toolCallId, { ...previous, ...event, arguments: event.arguments ?? previous?.arguments });
  }
  return [...tools.values()];
}
export type ToolDetailSection = { label: string; text: string; tone?: "removed" | "added" };
export function toolDetailSections(name: string, argumentsValue: unknown, result: unknown, failed = false): ToolDetailSection[] {
  const args = record(argumentsValue) ? argumentsValue : {};
  const sections: ToolDetailSection[] = [];
  const path = [args.path, args.filePath, args.file].find(value => typeof value === "string");
  const tool = name.toLowerCase(); // exact provider name, never output-derived
  if (["bash", "shell"].includes(tool)) {
    const command = args.command ?? args.cmd ?? args.script;
    if (typeof command === "string") sections.push({ label: "Command", text: bounded(command) });
    if (Object.keys(args).some(key => !["command", "cmd", "script", "timeout", "timeout_ms", "workdir"].includes(key))) sections.push({ label: "Arguments", text: readable(argumentsValue) });
  }
  if (["read", "write", "edit"].includes(tool) && typeof path === "string") sections.push({ label: "File", text: bounded(path) });
  if (tool === "write" && typeof args.content === "string") sections.push({ label: "Content", text: bounded(args.content) });
  if (tool === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    for (const edit of edits.slice(0, 32)) {
      if (!record(edit)) continue;
      const old = edit.oldText ?? edit.old_string;
      const next = edit.newText ?? edit.new_string;
      // These are exact replacement fragments, not invented file context/line numbers.
      if (typeof old === "string" && typeof next === "string") {
        sections.push({ label: "Removed", text: bounded(old), tone: "removed" }, { label: "Added", text: bounded(next), tone: "added" });
      }
    }
    if (edits.length > 32) sections.push({ label: "Edits", text: "[truncated]" });
  }
  if ((!sections.length || args.truncated === true) && argumentsValue !== undefined) sections.push({ label: "Arguments", text: readable(argumentsValue) });
  if (result !== undefined && result !== "") sections.push({ label: failed ? "Error" : tool === "read" ? "Content" : "Result", text: normalizeToolResult(result) });
  return sections;
}
