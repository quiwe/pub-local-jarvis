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
  manager.request = async (pathname, options = {}) => {
    requests.push([pathname, options.method || "GET"]);
    return {};
  };

  await manager.memoryStatus();
  await manager.memoryDays();
  await manager.memoryDay("2026-07-16");
  await manager.generateMemoryDay("2026-07-16");

  assert.deepEqual(requests, [
    ["/api/v1/memory/status", "GET"],
    ["/api/v1/memory/days", "GET"],
    ["/api/v1/memory/days/2026-07-16", "GET"],
    ["/api/v1/memory/days/2026-07-16/generate", "POST"],
  ]);
});
