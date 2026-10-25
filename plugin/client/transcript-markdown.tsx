/*
 * Markdown block styling is adapted from Paseo v0.12.0
 * (getpaseo/paseo cafe4b01c8522ff39560241c5deb01427dc8dc5b),
 * packages/app/src/components/markdown/styles.ts and renderer.tsx: paragraph/heading/list,
 * inline-code and fenced-code metrics. Paseo's app-private enriched-markdown and
 * link/image services are not imported; this small bounded tokenizer emits semantic
 * web tags and matching public React Native Text styles for retained prose.
 * See ../licenses/PASEO-APACHE-2.0.txt.
 */
import { createElement } from "react";
import { Text, View } from "react-native";

type InlinePart = string | { kind: "strong" | "em" | "del" | "code" | "link"; text: string };
const delimiters = ["**", "__", "~~", "`", "*", "_"] as const;
function tokenizeInline(source: string, depth = 0): InlinePart[] {
  if (depth > 6) return [source];
  const result: InlinePart[] = [];
  let plain = "", index = 0;
  const flush = () => { if (plain) { result.push(plain); plain = ""; } };
  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) { plain += source[index + 1]; index += 2; continue; }
    if (source[index] === "[") {
      const labelEnd = source.indexOf("](", index + 1), urlEnd = labelEnd >= 0 ? source.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd >= 0 && urlEnd > labelEnd + 2) { flush(); result.push({ kind: "link", text: source.slice(index + 1, labelEnd) }); index = urlEnd + 1; continue; }
    }
    let matched = false;
    for (const marker of delimiters) {
      if (!source.startsWith(marker, index)) continue;
      const close = source.indexOf(marker, index + marker.length);
      if (close <= index + marker.length) continue;
      flush();
      const kind = marker === "`" ? "code" : marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em";
      result.push({ kind, text: source.slice(index + marker.length, close) });
      index = close + marker.length; matched = true; break;
    }
    if (!matched) { plain += source[index]!; index++; }
  }
  flush();
  return result;
}
function renderInline(source: string, colors: any, web: boolean): any[] {
  return tokenizeInline(source).map((part, index) => {
    if (typeof part === "string") return part;
    const children = part.kind === "code" ? part.text : renderInline(part.text, colors, web);
    if (web) {
      const tags: Record<"strong" | "em" | "del" | "code" | "link", string> = { strong: "strong", em: "em", del: "del", code: "code", link: "span" };
      const style = part.kind === "code" ? { fontFamily: "monospace", fontSize: 12, backgroundColor: colors.surface1, color: colors.foreground, padding: "1px 3px", borderRadius: 3 }
        : part.kind === "link" ? { color: colors.accentBright, textDecoration: "underline" } : undefined;
      return createElement(tags[part.kind], { key: index, style }, children);
    }
    const style = part.kind === "strong" ? { fontWeight: "700" } : part.kind === "em" ? { fontStyle: "italic" }
      : part.kind === "del" ? { textDecorationLine: "line-through" } : part.kind === "code"
        ? { fontFamily: "monospace", fontSize: 12, backgroundColor: colors.surface1 } : { color: colors.accentBright, textDecorationLine: "underline" };
    return <Text key={index} style={style}>{children}</Text>;
  });
}

type Block = { kind: "paragraph" | "heading" | "quote" | "list" | "code"; text: string; level?: number };
function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [], code: string[] | undefined;
  const flush = () => { if (paragraph.length) { blocks.push({ kind: "paragraph", text: paragraph.join("\n") }); paragraph = []; } };
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flush();
      if (code) { blocks.push({ kind: "code", text: code.join("\n") }); code = undefined; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flush(); blocks.push({ kind: "heading", text: heading[2]!, level: heading[1]!.length }); continue; }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) { flush(); blocks.push({ kind: "list", text: line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "") }); continue; }
    if (/^\s*>\s?/.test(line)) { flush(); blocks.push({ kind: "quote", text: line.replace(/^\s*>\s?/, "") }); continue; }
    paragraph.push(line);
  }
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  flush();
  return blocks;
}

/** Markdown block/inline structure adapted for public RN primitives; web output retains semantic tags. */
export function TranscriptMarkdown({ text, colors, platform }: { text: string; colors: any; platform: string }) {
  const web = platform === "web";
  const blocks = parseBlocks(text);
  if (web) return <View style={{ gap: 8 }} testID="transcript-markdown">
    {blocks.map((block, index) => {
      if (block.kind === "code") return createElement("pre", { key: index, style: { margin: 0, padding: 10, borderRadius: 6, backgroundColor: colors.surface1, color: colors.foreground, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 12, lineHeight: "17px" } }, createElement("code", { style: { font: "inherit", color: "inherit" } }, block.text));
      if (block.kind === "heading") { const size = Math.max(14, 20 - (block.level ?? 1)); return createElement(`h${block.level ?? 1}`, { key: index, style: { margin: 0, color: colors.foreground, fontSize: size, lineHeight: `${Math.round(size * 1.3)}px`, fontWeight: 700 } }, renderInline(block.text, colors, web)); }
      if (block.kind === "quote") return createElement("blockquote", { key: index, style: { margin: 0, borderLeft: `3px solid ${colors.border}`, paddingLeft: 10, color: colors.foregroundMuted, fontSize: 14, lineHeight: "20px" } }, renderInline(block.text, colors, web));
      if (block.kind === "list") return createElement("ul", { key: index, style: { margin: 0, paddingLeft: 22, color: colors.foreground, fontSize: 14, lineHeight: "20px" } }, createElement("li", { style: { marginBottom: 4 } }, renderInline(block.text, colors, web)));
      return createElement("p", { key: index, style: { margin: 0, color: colors.foreground, fontSize: 14, lineHeight: "20px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, renderInline(block.text, colors, web));
    })}
  </View>;
  return <View style={{ gap: 8 }} testID="transcript-markdown">
    {blocks.map((block, index) => block.kind === "code"
      ? <View key={index} style={{ padding: 10, borderRadius: 6, backgroundColor: colors.surface1 }}><Text selectable style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }}>{block.text}</Text></View>
      : block.kind === "heading"
        ? <Text key={index} selectable style={{ color: colors.foreground, fontSize: Math.max(14, 20 - (block.level ?? 1)), lineHeight: 24, fontWeight: "700" }}>{renderInline(block.text, colors, web)}</Text>
        : block.kind === "quote"
          ? <View key={index} style={{ borderLeftWidth: 3, borderColor: colors.border, paddingLeft: 10 }}><Text selectable style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{renderInline(block.text, colors, web)}</Text></View>
          : block.kind === "list"
            ? <Text key={index} selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>• {renderInline(block.text, colors, web)}</Text>
            : <Text key={index} selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{renderInline(block.text, colors, web)}</Text>)}
  </View>;
}
