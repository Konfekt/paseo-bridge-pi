import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Preserve the same multimodal content for prompts, steering and follow-ups. */
export function remoteUserContent(
  message: string,
  images?: ImageContent[],
): string | (TextContent | ImageContent)[] {
  return Array.isArray(images) && images.length > 0
    ? [{ type: "text", text: message }, ...images]
    : message;
}
