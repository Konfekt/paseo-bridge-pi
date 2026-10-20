export function permissionModeId(enabled: boolean): "pi-prompts-on" | "pi-prompts-off";
export function handleSecurityModeRequest(
  command: unknown,
  dependencies: {
    context(): any;
    transport(): any;
    service(): any;
  },
): { success: false; error: string } | { success: true; data: { sessionId: string; runtimeEpoch: string; modeId: "pi-prompts-on" | "pi-prompts-off" } };
