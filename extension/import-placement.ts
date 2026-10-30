export function paseoImportArgs(input: {
  sessionFile: string; cwd: string; host?: string;
}): string[] {
  return ["import", "--provider", "pi", input.sessionFile, "--cwd", input.cwd, "--json",
    ...(input.host ? ["--host", input.host] : [])];
}

export function importRetryDelay(failures: number): number | undefined {
  return failures >= 1 && failures <= 5 ? Math.min(2000 * 2 ** (failures - 1), 30000) : undefined;
}
