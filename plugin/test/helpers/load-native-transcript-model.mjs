import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function loadNativeTranscriptModel() {
  const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
  assert.ok(compilerPath, "PASEO_PLUGIN_COMPILER is required");
  const root = await mkdtemp(resolve(tmpdir(), "paseo-native-transcript-model-"));
  try {
    const clientDir = resolve(root, "client");
    await mkdir(clientDir);
    await cp(new URL("../../client/native-transcript-model.ts", import.meta.url), resolve(clientDir, "native-transcript-model.ts"));
    await writeFile(
      resolve(root, "index.client.ts"),
      `import * as model from "./client/native-transcript-model";
import { getMarkdownCodeMetrics, getMarkdownTextMetrics } from "@getpaseo/plugin/shared";
export default function contribute() {
  return { ...model, getMarkdownCodeMetrics, getMarkdownTextMetrics };
}`,
    );

    const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
    const { clientBundle } = await compilePlugin({ client: resolve(root, "index.client.ts"), server: null });
    assert.ok(clientBundle, "compiler must return the client bundle");
    const model = (0, eval)(clientBundle)((name) => {
      throw new Error(`Unexpected host import in native transcript model bundle: ${name}`);
    }).default();
    return { ...model, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
