import * as piSdk from "@earendil-works/pi-coding-agent";

// Reviewed/tested targets; docs/reference.md records verification limits.
// Newer releases and pre-releases are attempted with a one-time warning.
export const PI_MIN_VERSION = "1.0.0";
export const PI_TESTED_VERSION = "1.6.0";
export const PASEO_MIN_VERSION = "0.13.0";
export const PASEO_TESTED_VERSION = "0.17.1";

type Release = { core: [number, number, number]; prerelease: boolean };

function parseRelease(version: string): Release | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined };
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Describe how `version` relates to the verified range, or return undefined when it is
 * verified or unknown. Patch releases of the tested minor line count as verified.
 */
export function versionWarning(component: string, version: string | null | undefined, minimum: string, tested: string): string | undefined {
  if (!version) return undefined;
  const release = parseRelease(version);
  const min = parseRelease(minimum);
  const top = parseRelease(tested);
  if (!release || !min || !top) return undefined;
  const range = `${minimum} to ${top.core[0]}.${top.core[1]}.x`;
  const versusMin = compare(release.core, min.core);
  if (versusMin < 0 || (versusMin === 0 && release.prerelease))
    return `${component} ${version} is older than the supported minimum ${minimum}; update it if the Paseo bridge misbehaves.`;
  const reason = release.prerelease
    ? `is a pre-release (tested range ${range})`
    : compare(release.core, [top.core[0], top.core[1], Number.MAX_SAFE_INTEGER]) > 0
      ? `is newer than the tested range (${range})`
      : undefined;
  return reason && `${component} ${version} ${reason}; continuing tentatively. Report problems if the Paseo bridge misbehaves.`;
}

/** The running Pi release. Read through the namespace so a Pi without this export still loads. */
export function runningPiVersion(): string | undefined {
  const version = (piSdk as { VERSION?: unknown }).VERSION;
  return typeof version === "string" && version !== "0.0.0" ? version : undefined;
}

export function piVersionWarning(version = runningPiVersion()): string | undefined {
  return versionWarning("Pi", version, PI_MIN_VERSION, PI_TESTED_VERSION);
}

export function paseoVersionWarning(version: string | null | undefined): string | undefined {
  return versionWarning("Paseo", version, PASEO_MIN_VERSION, PASEO_TESTED_VERSION);
}

// Shared across extension reloads in the same process, so each warning appears once.
const WARNED_KEY = "__piPaseoVersionWarningsV1";

/** Report `message` once per process; returns whether it was reported now. */
export function warnOnce(message: string | undefined, report: (message: string) => void): boolean {
  if (!message) return false;
  const root = globalThis as Record<string, unknown>;
  const warned = (root[WARNED_KEY] ??= new Set<string>()) as Set<string>;
  if (warned.has(message)) return false;
  warned.add(message);
  report(message);
  return true;
}
