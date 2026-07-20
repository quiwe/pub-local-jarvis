"use strict";

const path = require("node:path");
const { executeWithFallback, resourceEnvironments } = require("./resource-fallback");

function createBuildAttempts(environment = process.env) {
  const { primary, mirror, fallbackEnabled } = resourceEnvironments(environment);
  const cli = path.join(__dirname, "..", "node_modules", "electron-builder", "out", "cli", "cli.js");
  const common = {
    command: process.execPath,
    args: [cli, "--win", "nsis:x64"],
    cwd: path.join(__dirname, ".."),
    label: "Electron Builder",
  };
  return {
    primary: { ...common, env: primary },
    fallback: fallbackEnabled ? { ...common, env: mirror } : null,
  };
}

if (require.main === module) {
  executeWithFallback(createBuildAttempts()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createBuildAttempts };
