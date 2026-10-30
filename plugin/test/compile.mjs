import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
if (!compilerPath) {
  throw new Error("Set PASEO_PLUGIN_COMPILER to the stock Paseo 0.13.0 dist/server/server/plugins/compiler.js.");
}
const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
const root = await mkdtemp(resolve(tmpdir(), "paseo-plugin-compile-"));
try {
  // Compile only the shipped source tree, with no checkout dependencies.
  for (const path of ["client", "server", "shared", "index.client.tsx", "index.server.ts", "paseo-plugin.json"]) {
    await cp(fileURLToPath(new URL(`../${path}`, import.meta.url)), resolve(root, path), { recursive: true });
  }
  const bundles = await compilePlugin({ client: resolve(root, "index.client.tsx"), server: resolve(root, "index.server.ts") });
  if (!bundles.clientBundle || !bundles.serverBundle) throw new Error("Paseo compiler did not emit both plugin bundles");
  console.log(`Paseo plugin compile passed without local dependencies (client ${bundles.clientBundle.length} bytes, server ${bundles.serverBundle.length} bytes).`);
} finally {
  await rm(root, { recursive: true, force: true });
}
