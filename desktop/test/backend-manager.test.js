"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const WebSocket = require("ws");
const {
  BackendManager,
  StartCancelledError,
  backendLaunchSpec,
  createBackendOutputForwarder,
  parseBackendOutputLine,
  selectAvailablePort,
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

test("the packaged app launches its bundled runtime directly", () => {
  const root = "C:\\Program Files\\AI Jarvis\\resources\\backend";
  const spec = backendLaunchSpec(root, false, true);

  assert.equal(spec.executable, `${root}\\runtime\\jarvis-launcher.exe`);
  assert.deepEqual(spec.args, []);
});

test("backend output preserves UTF-8 characters split across chunks", () => {
  const messages = [];
  const forwarder = createBackendOutputForwarder(value => messages.push(value));
  const output = Buffer.from("正在下载模型\n本地服务已启动\n", "utf8");

  forwarder.write(output.subarray(0, 2));
  forwarder.write(output.subarray(2, 11));
  forwarder.write(output.subarray(11));
  forwarder.end();

  assert.deepEqual(messages, ["正在下载模型", "本地服务已启动"]);
});

test("backend output falls back to GB18030 for Windows native messages", () => {
  const messages = [];
  const forwarder = createBackendOutputForwarder(value => messages.push(value));

  forwarder.write(Buffer.from([0xc6, 0xf4, 0xb6]));
  forwarder.write(Buffer.from([0xaf, 0xca, 0xa7, 0xb0, 0xdc, 0x0a]));
  forwarder.end();

  assert.deepEqual(messages, ["启动失败"]);
});

test("packaged startup selects an available port and unique pipe", async () => {
  const manager = new BackendManager({
    backendRoot: process.cwd(),
    packaged: true,
    portSelector: async () => 43123,
    pipeNameFactory: () => "\\\\.\\pipe\\AIJarvis.Worker.test",
  });
  let healthChecks = 0;
  manager.health = async () => (++healthChecks > 1 ? { status: "ok" } : null);
  manager.waitForEventConnection = async () => {};
  manager.spawnBackend = () => {
    manager.child = { exitCode: null };
    assert.equal(manager.baseUrl, "http://127.0.0.1:43123");
    assert.equal(manager.pipeName, "\\\\.\\pipe\\AIJarvis.Worker.test");
  };

  await manager.start();

  assert.equal(manager.ownsBackend, true);
});

test("port selection skips an occupied preferred port", async (context) => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => occupied.close());
  const preferredPort = occupied.address().port;

  const selectedPort = await selectAvailablePort(preferredPort);

  assert.notEqual(selectedPort, preferredPort);
});

test("structured download progress is parsed and clamped", () => {
  const value = parseBackendOutputLine(
    'JARVIS_PROGRESS {"type":"download-progress","message":"正在下载模型","percent":104}',
  );

  assert.deepEqual(value, {
    type: "download-progress",
    message: "正在下载模型",
    percent: 100,
  });
});

test("structured runtime backend progress is preserved", () => {
  const value = parseBackendOutputLine(
    'JARVIS_PROGRESS {"type":"runtime-backend","backend":"cpu","message":"CPU fallback","reason":"CUDA failed"}',
  );

  assert.deepEqual(value, {
    type: "runtime-backend",
    backend: "cpu",
    message: "CPU fallback",
    reason: "CUDA failed",
  });
});

test("backend commands allow startup-specific timeouts", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  let request;
  manager.request = async (pathname, options) => { request = [pathname, options]; return {}; };

  await manager.command("start_monitoring", {}, { timeout: 180000 });

  assert.equal(request[0], "/api/v1/commands");
  assert.equal(request[1].timeout, 180000);
});

test("startup waits until the backend event channel is open", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  manager.socket = { readyState: WebSocket.CONNECTING };
  manager.connectEvents = () => {};
  setTimeout(() => { manager.socket.readyState = WebSocket.OPEN; }, 10);

  await assert.doesNotReject(manager.waitForEventConnection(undefined, 200));
});

test("pet chat uses the dedicated assistant endpoint", async () => {
  const manager = new BackendManager({ backendRoot: process.cwd() });
  let request;
  manager.request = async (pathname, options) => {
    request = [pathname, options];
    return { reply: "在。" };
  };

  assert.deepEqual(await manager.chat("在吗？"), { reply: "在。" });
  assert.equal(request[0], "/api/v1/assistant/chat");
  assert.equal(request[1].method, "POST");
  assert.deepEqual(JSON.parse(request[1].body), { message: "在吗？" });
  assert.equal(request[1].timeout, 10 * 60 * 1000 + 15 * 1000);
});
