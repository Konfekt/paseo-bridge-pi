/** Native code-surface rows: only Read offsets establish absolute positions.
 * Adapted from Paseo v0.12.0 (cafe4b01c8522ff39560241c5deb01427dc8dc5b)
 * HighlightedLines/ScrollableTextSection semantics. Apache-2.0 attribution:
 * ../licenses/PASEO-APACHE-2.0.txt.
 * No synthetic file context or hunk positions are generated from edit fragments.
 */
export type NativeCodeRow = { text: string; number?: number; tone?: "removed" | "added" | "context" };
export function nativeCodeRows(text: string, options: { startLine?: number; tone?: "removed" | "added"; unifiedDiff?: boolean } = {}): NativeCodeRow[] {
  const lines = text.split("\n");
  // A trailing newline terminates the preceding line, rather than creating a file line.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const start = Number.isSafeInteger(options.startLine) && options.startLine! > 0 ? options.startLine : undefined;
  const rows = lines.slice(0, 500).map((line, index): NativeCodeRow => ({
    text: line,
    ...(start !== undefined && line !== "[truncated]" ? { number: start + index } : {}),
    ...(options.tone ? { tone: options.tone } : options.unifiedDiff && !line.startsWith("---") && !line.startsWith("+++") ?
      { tone: line.startsWith("-") ? "removed" : line.startsWith("+") ? "added" : "context" } : {}),
  }));
  if (lines.length > 500) rows.push({ text: "[truncated]" });
  return rows;
}
