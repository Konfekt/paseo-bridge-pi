import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type PromptContent = string | Array<ImageContent | TextContent>;
type Delivery = "steer" | "followUp";
type PromptApi = {
  getCommands(): Array<{ name: string; source: string }>;
  sendUserMessage(content: PromptContent, options?: { deliverAs?: Delivery; expandPromptTemplates?: boolean }): void;
};

function isExtensionCommand(pi: PromptApi, message: string): boolean {
  if (!message.startsWith("/")) return false;
  // Match Pi's space-delimited command parser without changing its arguments.
  const space = message.indexOf(" ");
  const name = space < 0 ? message.slice(1) : message.slice(1, space);
  return pi.getCommands().some(command => command.source === "extension" && command.name === name);
}

export async function dispatchPaseoPrompt(
  pi: PromptApi,
  content: PromptContent,
  message: string,
  streaming: boolean,
  delivery?: Delivery,
): Promise<Record<string, never>> {
  // Native extension dispatch consumes the command text before image input.
  if (isExtensionCommand(pi, message) && Array.isArray(content) && content.some(block => block.type === "image")) {
    throw new Error("Extension commands do not accept image attachments. Send images as an ordinary prompt.");
  }
  const deliverAs = delivery ?? (streaming ? "followUp" : undefined);
  pi.sendUserMessage(content, { expandPromptTemplates: true, ...(deliverAs ? { deliverAs } : {}) });
  // The public API is fire-and-forget. This acknowledges submission, not a
  // completed command, started model turn, or backend result.
  return {};
}
