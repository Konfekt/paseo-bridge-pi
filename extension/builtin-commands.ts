import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Pi built-ins the bridge runs for Paseo, with the hints Paseo's command list shows. */
export const BRIDGE_HANDLED_COMMANDS = [
  { name: "name", description: "Show or set the session name: /name <name>" },
  { name: "model", description: "Show models or switch: /model <provider/model>" },
  { name: "thinking", description: "Show or set the thinking level: /thinking <level>" },
  { name: "session", description: "Show session info and stats" },
  { name: "export", description: "Export the session on the Pi host: /export [file.html|file.jsonl]" },
  { name: "btw", description: "Ask a side question without adding it to the session: /btw <question>" },
  { name: "new", description: "Start a new Pi session in the terminal: /new <first prompt>" },
  { name: "resume", description: "List recent sessions or switch the terminal to one: /resume [number|id]" },
  { name: "clone", description: "Duplicate the session at its current position into a new session" },
] as const;

export type BridgeHandledCommand = (typeof BRIDGE_HANDLED_COMMANDS)[number]["name"];

const HANDLED = new Set<string>(BRIDGE_HANDLED_COMMANDS.map(command => command.name));

/**
 * Pi's interactive built-ins as of the tested release, including hidden ones.
 * Installed Pi releases extend this list at runtime when their registry is
 * readable; a test compares it with the pinned Pi's registry.
 */
export const KNOWN_PI_BUILTINS = [
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
  "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
  "compact", "resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
] as const;

const TERMINAL_HINTS: Record<string, string> = {
  reload: "Use /remote-reload to reload Pi from Paseo while idle.",
  fork: "Use Paseo's fork action, or run /fork in the terminal.",
  tree: "Navigate the session tree in the terminal.",
  copy: "Copy the message in Paseo instead.",
  quit: "Quit Pi in the terminal; archiving the chat in Paseo only hides it.",
  login: "Sign in from the terminal.",
  logout: "Sign out from the terminal.",
  settings: "Change settings in the terminal.",
};

export type SlashInvocation = { name: string; args: string };

/** Parse like Paseo and Pi: `/name args`, where a name containing `/` is a path, not a command. */
export function parseSlashInvocation(message: string): SlashInvocation | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) return null;
  const rest = trimmed.slice(1);
  const space = rest.search(/\s/);
  const name = space < 0 ? rest : rest.slice(0, space);
  if (!name || name.includes("/")) return null;
  return { name, args: space < 0 ? "" : rest.slice(space + 1).trim() };
}

export type CommandRoute =
  | { kind: "pass" }
  | { kind: "bridge"; name: BridgeHandledCommand; args: string }
  | { kind: "reject"; message: string };

/**
 * Decide who runs a Paseo prompt. Extension, prompt-template and skill
 * commands of the same name win, as they reach Pi's own dispatcher.
 * Pi's interactive built-ins are not executed by `sendUserMessage`; they
 * would reach the model as plain text, so they are run here or refused.
 */
export function routePaseoCommand(
  message: string,
  piCommands: ReadonlyArray<{ name: string; source?: string }>,
  builtins: ReadonlySet<string>,
  options: { nativeBtw?: boolean } = {},
): CommandRoute {
  const parsed = parseSlashInvocation(message);
  if (!parsed) return { kind: "pass" };
  const { name, args } = parsed;
  // Extensions such as pi-btw register a terminal overlay; Paseo cannot show it.
  if (name === "btw" && options.nativeBtw !== false) return { kind: "bridge", name, args };
  if (piCommands.some(command => command.name === name)) return { kind: "pass" };
  if (name.startsWith("skill:")) return { kind: "pass" };
  if (HANDLED.has(name)) return { kind: "bridge", name: name as BridgeHandledCommand, args };
  if (name === "compact" || !builtins.has(name)) return { kind: "pass" };
  const hint = TERMINAL_HINTS[name] ?? "Run it in the attached terminal.";
  return { kind: "reject", message: `/${name} is a Pi terminal command and is not available from Paseo. ${hint}` };
}

/** Commands Paseo should list besides Pi's own extension, prompt and skill commands. */
export function bridgeCommandEntries(piCommands: ReadonlyArray<{ name: string }>) {
  const taken = new Set(piCommands.map(command => command.name));
  return BRIDGE_HANDLED_COMMANDS
    .filter(command => command.name === "btw" || !taken.has(command.name))
    .map(command => ({ name: command.name, description: command.description, source: "extension" as const }));
}

/** Find Pi's package root from its running CLI entry point. */
function piPackageRoot(entry: string | undefined): string | undefined {
  if (!entry) return undefined;
  let directory: string;
  try {
    directory = path.dirname(fs.realpathSync(entry));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && manifest.name.endsWith("/pi-coding-agent")) return directory;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Pi's built-in names: the maintained list plus the running Pi's own registry
 * when its package files are readable (npm installs). Compiled binaries keep
 * the maintained list.
 */
export async function loadPiBuiltinNames(entry: string | undefined = process.argv[1]): Promise<Set<string>> {
  const names = new Set<string>(KNOWN_PI_BUILTINS);
  const root = piPackageRoot(entry);
  const registry = root ? path.join(root, "dist", "core", "slash-commands.js") : undefined;
  if (registry && fs.existsSync(registry)) {
    try {
      const module = await import(pathToFileURL(registry).href);
      for (const command of module.BUILTIN_SLASH_COMMANDS ?? []) {
        if (typeof command?.name === "string") names.add(command.name);
      }
    } catch {}
  }
  return names;
}
