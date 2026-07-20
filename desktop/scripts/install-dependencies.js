"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { executeWithFallback, resourceEnvironments } = require("./resource-fallback");

function runningProjectElectronProcessIds(
  cwd,
  run = spawnSync,
  platform = process.platform,
) {
  if (platform !== "win32") return [];
  const executable = path.join(cwd, "node_modules", "electron", "dist", "electron.exe");
  const escaped = executable.replaceAll("'", "''");
  const script = [
    `$target = '${escaped}';`,
    "@(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction SilentlyContinue",
    "| Where-Object { $_.ExecutablePath -eq $target }",
    "| Select-Object -ExpandProperty ProcessId) -join ','",
  ].join(" ");
  const result = run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || "")
    .trim()
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function createInstallAttempts(environment = process.env) {
  if (!environment.npm_execpath) {
    throw new Error("Run this installer through npm run deps:install.");
  }
  const { primary, mirror, fallbackEnabled } = resourceEnvironments(environment);
  const cwd = path.join(__dirname, "..");
  const baseArgs = [
    environment.npm_execpath,
    "ci",
    "--fetch-timeout=30000",
    "--fetch-retries=1",
  ];
  const common = {
    command: process.execPath,
    cwd,
    label: "npm dependency installation",
  };
  return {
    primary: {
      ...common,
      args: [...baseArgs, "--registry=https://registry.npmjs.org"],
      env: primary,
    },
    fallback: fallbackEnabled
      ? {
          ...common,
          args: [
            ...baseArgs,
            `--registry=${environment.JARVIS_NPM_MIRROR || "https://registry.npmmirror.com"}`,
          ],
          env: mirror,
        }
      : null,
  };
}

if (require.main === module) {
  const attempts = createInstallAttempts();
  const processIds = runningProjectElectronProcessIds(attempts.primary.cwd);
  if (processIds.length > 0) {
    console.error(
      `Close the running AI Jarvis desktop app before installing dependencies (processes: ${processIds.join(", ")}).`,
    );
    process.exitCode = 1;
  } else {
    executeWithFallback(attempts).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { createInstallAttempts, runningProjectElectronProcessIds };
