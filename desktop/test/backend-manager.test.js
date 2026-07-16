"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BackendManager, StartCancelledError } = require("../src/backend-manager");

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
