type PromptContent = string | Array<Record<string, unknown>>;
type PromptOptions = {
  deliverAs?: "steer" | "followUp";
  expandPromptTemplates?: boolean;
};
type PromptCommand = { name: string; source: string };
type PromptApi = {
  getCommands(): PromptCommand[];
  sendUserMessage(content: PromptContent, options?: PromptOptions): void | Promise<void>;
  dispatchCancellablePrompt?(content: PromptContent, options?: PromptOptions): Promise<boolean>;
};

function extensionCommandName(message: string): string | null {
  if (!message.startsWith("/")) return null;
  const name = message.slice(1).split(/\s/, 1)[0];
  return name || null;
}

export function isExtensionCommand(pi: PromptApi, message: string): boolean {
  const name = extensionCommandName(message);
  return name !== null && pi.getCommands().some((command) => command.source === "extension" && command.name === name);
}

export async function dispatchPaseoPrompt(
  pi: PromptApi,
  content: PromptContent,
  message: string,
  streaming: boolean,
  onAsyncError: (error: unknown) => void = () => {},
): Promise<{ agentInvoked: boolean; cancelled?: boolean }> {
  const command = isExtensionCommand(pi, message);
  const options = {
    ...(streaming ? { deliverAs: "followUp" as const } : {}),
    expandPromptTemplates: true,
  };
  if (!command && pi.dispatchCancellablePrompt) {
    const submitted = await pi.dispatchCancellablePrompt(content, options);
    return submitted ? { agentInvoked: true } : { agentInvoked: false, cancelled: true };
  }
  const submission = pi.sendUserMessage(content, options);

  // Extension commands execute immediately and may be asynchronous. Wait for
  // them so Paseo receives a failure rather than treating the command as an
  // accepted agent prompt. Ordinary prompts intentionally remain asynchronous,
  // matching the RPC protocol's acceptance response.
  if (command) await submission;
  else if (submission && typeof submission.catch === "function") void submission.catch(onAsyncError);

  return { agentInvoked: !command };
}
