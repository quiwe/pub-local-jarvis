"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BackendManager,
  StartCancelledError,
  backendLaunchSpec,
} = require("../src/backend-manager");

test("the real backend launcher has no browser mode", () => {
  const root = "C:\\AIJarvis";
  const spec = backendLaunchSpec(root, false);

  assert.equal(spec.executable, "powershell.exe");
  assert.deepEqual(spec.args, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `${root}\\start-real.ps1`,
    "-SkipSmokeTest",
  ]);
});

test("an aborted start never spawns the backend", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  let spawned = false;
  manager.spawnBackend = () => { spawned = true; };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(manager.start({ signal: controller.signal }), StartCancelledError);
  assert.equal(spawned, false);
});

test("cancelling without a live child is idempotent", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  await assert.doesNotReject(manager.cancelStart());
  await assert.doesNotReject(manager.cancelStart());
});

test("stopping an owned backend terminates its complete process tree", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  let terminated = false;
  manager.ownsBackend = true;
  manager.command = async () => ({});
  manager.terminateChildTree = async () => { terminated = true; };

  await manager.stop();

  assert.equal(terminated, true);
  assert.equal(manager.ownsBackend, false);
});

test("memory helpers use the daily memory API", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  const requests = [];
  let imageRequest;
  manager.request = async (pathname, options = {}) => {
    requests.push([pathname, options.method || "GET"]);
    if (pathname.endsWith("/images") && options.method === "POST") imageRequest = options;
    return {};
  };

  await manager.memoryStatus();
  await manager.memoryDays();
  await manager.memoryDay("2026-07-16");
  await manager.generateMemoryDay("2026-07-16");
  await manager.memoryImages("2026-07-16");
  await manager.memoryImages();
  await manager.generateMemoryImage("2026-07-16", {
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    modelName: "image-model",
  });

  assert.deepEqual(requests, [
    ["/api/v1/memory/status", "GET"],
    ["/api/v1/memory/days", "GET"],
    ["/api/v1/memory/days/2026-07-16", "GET"],
    ["/api/v1/memory/days/2026-07-16/generate", "POST"],
    ["/api/v1/memory/days/2026-07-16/images", "GET"],
    ["/api/v1/memory/images", "GET"],
    ["/api/v1/memory/days/2026-07-16/images", "POST"],
  ]);
  assert.deepEqual(JSON.parse(imageRequest.body), {
    base_url: "https://images.example/v1",
    api_key: "secret",
    model_name: "image-model",
  });
  assert.equal(imageRequest.timeout, 10 * 60 * 1000);
});
