import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const extensionDir = norm(path.join(repoRoot, "extension"));
export const shimPath = norm(path.join(repoRoot, "shim", "pi-paseo-shim.js"));
export const piSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
export const paseoConfigPath = path.join(resolvePaseoHome(), "config.json");
export const RPIV_INCOMPATIBILITY_WARNING =
  "Compatibility warning: @juicesharp/rpiv-ask-user-question is incompatible with terminal-attached sessions in stock Paseo. App submissions do not reach its custom terminal widget. If installed, disable its extensions with pi config, then reload idle Pi sessions. See docs/reference.md#incompatible-question-package.";

/** Paseo's home, as Paseo resolves it: `PASEO_HOME` with `~` expanded, else `~/.paseo`. */
export function resolvePaseoHome(env = process.env) {
  const raw = env.PASEO_HOME?.trim() || "~/.paseo";
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

export function norm(p) {
  return p.replaceAll("\\", "/");
}

export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const na = norm(path.resolve(a));
  const nb = norm(path.resolve(b));
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// Throws on invalid JSON so we never clobber a file we couldn't parse.
export function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isOurShimCommand(command) {
  return (
    Array.isArray(command) &&
    command.some((part) => typeof part === "string" && norm(part).toLowerCase().endsWith("/shim/pi-paseo-shim.js"))
  );
}

/**
 * Point Paseo's pi provider at the shim. Mutates config only when it changes;
 * never replaces another provider command.
 * @returns {"installed" | "already-installed" | "conflict"}
 */
export function addShimToPaseoConfig(config, command) {
  const current = config.agents?.providers?.pi?.command;
  if (isOurShimCommand(current)) return "already-installed";
  if (current) return "conflict";
  config.agents ??= {};
  config.agents.providers ??= {};
  config.agents.providers.pi = { ...config.agents.providers.pi, command };
  return "installed";
}

/**
 * Remove the shim registration, pruning containers it leaves empty.
 * @returns {"removed" | "not-installed" | "conflict"}
 */
export function removeShimFromPaseoConfig(config) {
  const provider = config?.agents?.providers?.pi;
  if (!provider?.command) return "not-installed";
  if (!isOurShimCommand(provider.command)) return "conflict";
  delete provider.command;
  if (Object.keys(provider).length === 0) delete config.agents.providers.pi;
  if (Object.keys(config.agents.providers).length === 0) delete config.agents.providers;
  if (Object.keys(config.agents).length === 0) delete config.agents;
  return "removed";
}
