"use strict";

const path = require("node:path");
const {
  executeWithFallback,
  resourceEnvironments,
  runCommand,
} = require("./resource-fallback");

function prepareReleaseAttempt(environment = process.env) {
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "prepare-release.ps1"),
    ],
    cwd: path.join(__dirname, "..", ".."),
    env: environment,
    label: "Release runtime preparation",
  };
}

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
  const preparation = prepareReleaseAttempt();
  runCommand(
    preparation.command,
    preparation.args,
    preparation,
  ).then(() => executeWithFallback(createBuildAttempts())).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createBuildAttempts, prepareReleaseAttempt };
