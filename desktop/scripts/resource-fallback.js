"use strict";

const { spawn } = require("node:child_process");

const MIRROR_ENV_KEYS = [
  "ELECTRON_MIRROR",
  "ELECTRON_BUILDER_BINARIES_MIRROR",
];

function isEnabled(value) {
  return !["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function resourceEnvironments(environment = process.env) {
  const primary = { ...environment };
  for (const key of MIRROR_ENV_KEYS) delete primary[key];

  const mirror = {
    ...primary,
    ELECTRON_MIRROR:
      environment.JARVIS_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
    ELECTRON_BUILDER_BINARIES_MIRROR:
      environment.JARVIS_ELECTRON_BUILDER_MIRROR ||
      "https://npmmirror.com/mirrors/electron-builder-binaries/",
  };
  return {
    primary,
    mirror,
    fallbackEnabled: isEnabled(environment.JARVIS_DISABLE_DOWNLOAD_MIRROR),
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${options.label || command} failed with ${detail}`));
    });
  });
}

async function executeWithFallback(attempts, runner = runCommand, logger = console) {
  let primaryError;
  try {
    await runner(attempts.primary.command, attempts.primary.args, attempts.primary);
    return "primary";
  } catch (error) {
    primaryError = error;
  }

  if (!attempts.fallback) throw primaryError;
  logger.warn(`${primaryError.message}. Retrying with the configured mainland China mirror.`);
  try {
    await runner(attempts.fallback.command, attempts.fallback.args, attempts.fallback);
    return "mirror";
  } catch (mirrorError) {
    throw new AggregateError(
      [primaryError, mirrorError],
      `${attempts.primary.label} failed from both the official source and mirror`,
    );
  }
}

module.exports = {
  executeWithFallback,
  resourceEnvironments,
  runCommand,
};
