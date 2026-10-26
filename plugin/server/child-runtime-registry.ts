import { constants, lstat, open, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function processStartToken(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch { return null; }
}

/** Bounded private metadata only; never read child history or snapshot files. */
export async function readPrivateChildRuntimes() {
  const directory = join(homedir(), ".pi", "paseo-bridge", "runtimes");
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error("Child runtime registry is unavailable.");
  const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
  if (names.length > 4096) throw new Error("Child runtime registry exceeds its read budget.");
  const records = [];
  for (const name of names) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("Unsafe child runtime record.");
      const value = JSON.parse(await file.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsafe child runtime record.");
      const after = await file.stat();
      if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Child runtime record changed while reading.");
      records.push(value);
    } finally { await file.close(); }
  }
  return records;
}
