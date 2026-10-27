// Presentation adapter only. Highlighting and diff logic are owned by Paseo's
// reusable package and bundled into this plugin by the host packaging layer.
import { highlightToKeyedLines, highlightDiffLines, extensionFromPath, resolveSyntaxColors } from "@getpaseo/highlight";
import type { HighlightDiffLine } from "@getpaseo/highlight";
import type { NativeCodeRow } from "./native-code-model";
export type SyntaxToken = { text: string; style: string | null };
export function highlightNativeRows(rows: NativeCodeRow[], text: string, filePath: string | undefined, unifiedDiff = false): (NativeCodeRow & { tokens?: SyntaxToken[] })[] {
  if (!filePath) return rows;
  if (unifiedDiff) {
    const lines = highlightDiffLines(rows.map((row): HighlightDiffLine => ({ type: row.text.startsWith("@@") || row.text.startsWith("---") || row.text.startsWith("+++") ? "hunk" : row.tone === "removed" ? "remove" : row.tone === "added" ? "add" : "context", content: row.text })), filePath);
    return rows.map((row,index) => {
      const tokens = lines[index].tokens;
      const prefix = /^[ +\-]/.test(row.text) ? row.text[0] : "";
      return tokens ? { ...row, tokens: [...(prefix ? [{ text: prefix, style: null }] : []), ...tokens] } : row;
    });
  }
  const highlighted = highlightToKeyedLines(text, extensionFromPath(filePath));
  return rows.map((row,index) => highlighted?.[index] && row.text !== "[truncated]" ? { ...row, tokens: highlighted[index].tokens.map(value => value.token) } : row);
}
/** Public PluginTheme omits syntax colors/brand. Reuse native GitHub defaults
 * on its exposed light/dark surface; never invent a replacement token palette.
 * A future supported syntax palette is used directly if provided by the host. */
export function nativeSyntaxPalette(colors: any): Record<string,string> {
  if (colors.syntax) return colors.syntax;
  const hex = /^#([\da-f]{6})$/i.exec(colors.surface0 ?? "");
  const value = hex ? parseInt(hex[1],16) : 0xffffff;
  const light = (((value>>16)&255)*299 + ((value>>8)&255)*587 + (value&255)*114) >= 128000;
  return resolveSyntaxColors("github",light ? "light" : "dark");
}
