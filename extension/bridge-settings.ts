import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function bridgeSettingsFile(): string {
  return path.join(getAgentDir(), "paseo-bridge", "settings.json");
}

const legacySettingsFile = path.join(os.homedir(), ".pi", "paseo-bridge", "settings.json");

function readSettings(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function readBridgeSettings(): Record<string, unknown> {
  try {
    return readSettings(bridgeSettingsFile());
  } catch (error) {
    // Only absence permits the legacy preference fallback. A canonical file
    // (even invalid/unreadable) supersedes legacy settings, never merges them.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {};
  }
  try {
    // Legacy is read-only compatibility, not a migration of unrelated state.
    const { auto } = readSettings(legacySettingsFile);
    return typeof auto === "boolean" ? { auto } : {};
  } catch {
    return {};
  }
}

export function environmentBoolean(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true" || value === "on") return true;
  return fallback;
}

export function isAutoEnabled(): boolean {
  const { auto } = readBridgeSettings();
  return typeof auto === "boolean" ? auto : environmentBoolean("PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT");
}

export function isImportEnabled(): boolean {
  // Preserve the old presence/truthiness semantics, including NO_IMPORT=0.
  return !process.env.PI_PASEO_BRIDGE_NO_IMPORT && environmentBoolean("PI_PASEO_BRIDGE_IMPORT_SESSIONS");
}

function assertMutableTarget(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Do not follow or replace a declaratively managed symlink, even if its
  // parent is writable. Mode checks also protect read-only files when root.
  if (stat.isSymbolicLink() || !stat.isFile() || !(stat.mode & 0o222)) {
    throw new Error(`Refusing to update immutable or symlinked file ${file}; change its declarative configuration instead.`);
  }
  fs.accessSync(file, fs.constants.W_OK);
}

export function writeMutableJson(file: string, value: Record<string, unknown>): void {
  let temporary: string | undefined;
  try {
    assertMutableTarget(file);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    if (!(fs.statSync(directory).mode & 0o222)) {
      throw new Error(`Refusing to update immutable directory ${directory}; change its declarative configuration instead.`);
    }
    fs.accessSync(directory, fs.constants.W_OK);
    const temporaryPath = path.join(directory, `.settings-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    const fd = fs.openSync(temporaryPath, "wx", 0o600);
    temporary = temporaryPath;
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertMutableTarget(file);
    // Same-directory rename atomically replaces the file, never writes through
    // its target. Recheck above also refuses a newly installed managed symlink.
    fs.renameSync(temporary, file);
    temporary = undefined;
  } catch (error) {
    throw new Error(`Cannot save ${file}: ${error instanceof Error ? error.message : String(error)}. Keep mutable preferences writable; manage immutable configuration declaratively.`);
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch { /* preserve the original failure */ }
    }
  }
}

export function writeBridgeSettings(patch: Record<string, unknown>): void {
  const file = bridgeSettingsFile();
  assertMutableTarget(file);
  let current: Record<string, unknown> = {};
  try {
    current = readSettings(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read ${file}; refusing to overwrite existing settings: ${String(error)}`);
    }
  }
  // Never copy legacy files or credentials/state into the canonical directory.
  writeMutableJson(file, { ...current, ...patch });
}
