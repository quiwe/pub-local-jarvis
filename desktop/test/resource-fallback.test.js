"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createBuildAttempts } = require("../scripts/build");
const {
  createInstallAttempts,
  runningProjectElectronProcessIds,
} = require("../scripts/install-dependencies");
const { executeWithFallback } = require("../scripts/resource-fallback");

test("build uses official Electron sources before mainland mirrors", () => {
  const attempts = createBuildAttempts({
    ELECTRON_MIRROR: "https://unexpected.example/electron/",
    ELECTRON_BUILDER_BINARIES_MIRROR: "https://unexpected.example/builder/",
    JARVIS_ELECTRON_MIRROR: "https://mirror.example/electron/",
    JARVIS_ELECTRON_BUILDER_MIRROR: "https://mirror.example/builder/",
  });

  assert.equal(attempts.primary.env.ELECTRON_MIRROR, undefined);
  assert.equal(attempts.primary.env.ELECTRON_BUILDER_BINARIES_MIRROR, undefined);
  assert.equal(attempts.primary.env.NO_UPDATE_NOTIFIER, "1");
  assert.equal(attempts.fallback.env.ELECTRON_MIRROR, "https://mirror.example/electron/");
  assert.equal(
    attempts.fallback.env.ELECTRON_BUILDER_BINARIES_MIRROR,
    "https://mirror.example/builder/",
  );
});

test("dependency install falls back to the configured npm registry", () => {
  const attempts = createInstallAttempts({
    npm_execpath: "C:/npm/npm-cli.js",
    JARVIS_NPM_MIRROR: "https://registry.example",
  });

  assert.ok(attempts.primary.args.includes("--registry=https://registry.npmjs.org"));
  assert.ok(attempts.fallback.args.includes("--registry=https://registry.example"));
});

test("mirror fallback can be disabled", () => {
  const attempts = createBuildAttempts({ JARVIS_DISABLE_DOWNLOAD_MIRROR: "true" });
  assert.equal(attempts.fallback, null);
});

test("dependency install detects a running project Electron process", () => {
  const run = (_command, args, _options) => {
    assert.match(args.at(-1), /\$target = '.*'; @\(Get-CimInstance/);
    return { status: 0, stdout: "123,456\r\n" };
  };
  assert.deepEqual(
    runningProjectElectronProcessIds("C:/AIJarvis/desktop", run, "win32"),
    ["123", "456"],
  );
  assert.deepEqual(runningProjectElectronProcessIds("/tmp/desktop", run, "linux"), []);
});

test("a failed official attempt is retried once with the mirror", async () => {
  const calls = [];
  const runner = async (_command, _args, options) => {
    calls.push(options.env.SOURCE);
    if (calls.length === 1) throw new Error("official source timed out");
  };
  const logger = { warn() {} };
  const result = await executeWithFallback(
    {
      primary: { command: "tool", args: [], label: "resource", env: { SOURCE: "official" } },
      fallback: { command: "tool", args: [], label: "resource", env: { SOURCE: "mirror" } },
    },
    runner,
    logger,
  );

  assert.equal(result, "mirror");
  assert.deepEqual(calls, ["official", "mirror"]);
});
