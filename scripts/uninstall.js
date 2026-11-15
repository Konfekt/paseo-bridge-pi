import {
  extensionDir,
  paseoConfigPath,
  piSettingsPath,
  readJson,
  removeShimFromPaseoConfig,
  samePath,
  writeJson,
} from "./config.js";

let changed = false;

// 1. Remove the pi extension entry from ~/.pi/agent/settings.json.
const settings = readJson(piSettingsPath);
if (settings && Array.isArray(settings.extensions)) {
  const remaining = settings.extensions.filter((entry) => !samePath(entry, extensionDir));
  if (remaining.length !== settings.extensions.length) {
    settings.extensions = remaining;
    if (settings.extensions.length === 0) delete settings.extensions;
    writeJson(piSettingsPath, settings);
    console.log(`removed pi extension from ${piSettingsPath}`);
    changed = true;
  }
}
if (!changed) console.log("pi extension was not registered");

// 2. Remove the shim from Paseo's pi provider command.
const config = readJson(paseoConfigPath);
const shimResult = removeShimFromPaseoConfig(config);
if (shimResult === "removed") {
  writeJson(paseoConfigPath, config);
  console.log(`removed paseo pi provider shim from ${paseoConfigPath}`);
  changed = true;
} else if (shimResult === "conflict") {
  console.log(`leaving ${paseoConfigPath} untouched - pi provider command is not the bridge shim:`);
  console.log(`  ${JSON.stringify(config.agents.providers.pi.command)}`);
} else {
  console.log("paseo shim was not registered");
}

if (changed) {
  console.log("\nDone. Restart the Paseo daemon to apply: paseo restart");
  console.log("(restarting interrupts agents that are currently running)");
} else {
  console.log("\nNothing to do - already uninstalled.");
}
