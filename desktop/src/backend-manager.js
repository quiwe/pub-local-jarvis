"use strict";

const { EventEmitter } = require("node:events");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const WebSocket = require("ws");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROGRESS_PREFIX = "JARVIS_PROGRESS ";

function parseBackendOutputLine(line) {
  const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!cleaned) return null;
  if (!cleaned.startsWith(PROGRESS_PREFIX)) return cleaned;
  try {
    const payload = JSON.parse(cleaned.slice(PROGRESS_PREFIX.length));
    if (payload?.type === "download-progress" && Number.isFinite(payload.percent)) {
      return { ...payload, percent: Math.max(0, Math.min(100, payload.percent)) };
    }
  } catch (_) {}
  return null;
}

function createBackendOutputForwarder(onMessage) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";

  const drain = flush => {
    const lines = buffered.split(/\r\n|\n|\r/);
    const tail = lines.pop() || "";
    buffered = flush ? "" : tail;
    for (const line of lines) {
      const value = parseBackendOutputLine(line);
      if (value) onMessage(value);
    }
    if (flush && tail) {
      const value = parseBackendOutputLine(tail);
      if (value) onMessage(value);
    }
  };

  return {
    write(chunk) {
      buffered += decoder.write(chunk);
      drain(false);
    },
    end() {
      buffered += decoder.end();
      drain(true);
    },
  };
}

class StartCancelledError extends Error {
  constructor() {
    super("启动已取消");
    this.name = "StartCancelledError";
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new StartCancelledError();
}

function backendLaunchSpec(backendRoot, useFake, packaged = false) {
  if (useFake) {
    return {
      executable: path.join(backendRoot, ".venv", "Scripts", "jarvis-backend.exe"),
      args: [],
    };
  }
  if (packaged) {
    return {
      executable: path.join(backendRoot, "runtime", "jarvis-launcher.exe"),
      args: [],
    };
  }
  return {
    executable: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(backendRoot, "start-real.ps1"),
      "-SkipSmokeTest",
    ],
  };
}

class BackendManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl || "http://127.0.0.1:8000";
    this.backendRoot = options.backendRoot;
    this.dataRoot = options.dataRoot;
    this.packaged = options.packaged === true;
    this.useFake = options.useFake === true;
    this.child = null;
    this.ownsBackend = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.stopping = false;
  }

  async request(pathname, options = {}) {
    const timeoutSignal = AbortSignal.timeout(options.timeout || 8000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        const value = JSON.parse(body);
        if (typeof value.detail === "string") message = value.detail;
      } catch (_) {}
      throw new Error(message || `Backend request failed (${response.status})`);
    }
    return response.json();
  }

  async health(signal) {
    try {
      const value = await this.request("/api/v1/health", { timeout: 1500, signal });
      return value.status === "ok" && value.native_connected ? value : null;
    } catch (_) {
      return null;
    }
  }

  async waitForEventConnection(signal, timeout = 10000) {
    const deadline = Date.now() + timeout;
    this.connectEvents();
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      if (this.socket?.readyState === WebSocket.OPEN) return;
      if (!this.socket || this.socket.readyState > WebSocket.OPEN) this.connectEvents();
      await delay(50);
    }
    throw new Error("后端事件通道连接超时，请重新启动应用");
  }

  async start(options = {}) {
    const { signal } = options;
    throwIfCancelled(signal);
    if (await this.health(signal)) {
      throwIfCancelled(signal);
      this.emit("progress", "检测到正在运行的后端，正在连接");
      await this.waitForEventConnection(signal);
      return { owned: false };
    }
    this.emit("progress", this.useFake ? "正在启动开发后端" : "正在检查本地模型与运行时");
    throwIfCancelled(signal);
    this.spawnBackend();
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`后端启动进程已退出，代码 ${this.child.exitCode}`);
      }
      if (await this.health(signal)) {
        throwIfCancelled(signal);
        this.ownsBackend = true;
        this.emit("progress", "后端已就绪");
        await this.waitForEventConnection(signal);
        return { owned: true };
      }
      await delay(1000);
    }
    throw new Error("后端在 15 分钟内未就绪，请查看启动日志");
  }

  async cancelStart() {
    await this.terminateChildTree();
    this.ownsBackend = false;
  }

  async terminateChildTree() {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    if (process.platform === "win32" && child.pid) {
      await new Promise(resolve => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => {
          child.kill();
          resolve();
        });
        killer.once("close", resolve);
      });
    } else {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("close", resolve));
    }
    this.child = null;
  }

  spawnBackend() {
    if (this.child && this.child.exitCode === null) return;
    const { executable, args } = backendLaunchSpec(
      this.backendRoot,
      this.useFake,
      this.packaged,
    );
    this.child = spawn(executable, args, {
      cwd: this.backendRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        ...(this.dataRoot ? { JARVIS_DATA_ROOT: this.dataRoot } : {}),
      },
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      const forwarder = createBackendOutputForwarder(value => this.emit("progress", value));
      stream.on("data", chunk => forwarder.write(chunk));
      stream.on("end", () => forwarder.end());
    }
    this.child.on("error", error => this.emit("error", error));
  }

  connectEvents() {
    if (this.stopping || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const url = this.baseUrl.replace(/^http/, "ws") + "/ws/events";
    this.socket = new WebSocket(url);
    this.socket.on("message", raw => {
      try {
        this.emit("event", JSON.parse(raw.toString("utf8")));
      } catch (_) {
        this.emit("progress", "收到无法解析的后端事件");
      }
    });
    this.socket.on("close", () => {
      this.socket = null;
      if (!this.stopping) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connectEvents(), 2000);
      }
    });
    this.socket.on("error", () => {});
  }

  command(command, argumentsValue = {}, options = {}) {
    return this.request("/api/v1/commands", {
      method: "POST",
      body: JSON.stringify({ command, arguments: argumentsValue }),
      timeout: options.timeout || 2 * 60 * 1000,
    });
  }

  chat(message) {
    return this.request("/api/v1/assistant/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
      timeout: 3 * 60 * 1000,
    });
  }

  addKeyframe(sessionId, payload) {
    return this.request(`/api/v1/courses/${encodeURIComponent(sessionId)}/keyframes`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeout: 15000,
    });
  }

  memoryStatus() {
    return this.request("/api/v1/memory/status");
  }

  memoryDays() {
    return this.request("/api/v1/memory/days");
  }

  memoryDay(day) {
    return this.request(`/api/v1/memory/days/${encodeURIComponent(day)}`);
  }

  generateMemoryDay(day) {
    return this.request(`/api/v1/memory/days/${encodeURIComponent(day)}/generate`, {
      method: "POST",
      timeout: 10 * 60 * 1000,
    });
  }

  memoryImages(day) {
    const suffix = day ? `/days/${encodeURIComponent(day)}` : "";
    return this.request(`/api/v1/memory${suffix}/images`);
  }

  generateMemoryImage(day, settings) {
    return this.request(`/api/v1/memory/days/${encodeURIComponent(day)}/images`, {
      method: "POST",
      body: JSON.stringify({
        base_url: settings.baseUrl,
        api_key: settings.apiKey,
        model_name: settings.modelName,
      }),
      timeout: 10 * 60 * 1000,
    });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.close();
    if (this.ownsBackend) {
      try {
        await this.command("shutdown", {}, { timeout: 5000 });
      } catch (_) {}
      await delay(800);
      await this.terminateChildTree();
    }
    this.ownsBackend = false;
  }
}

module.exports = {
  BackendManager,
  StartCancelledError,
  backendLaunchSpec,
  createBackendOutputForwarder,
  parseBackendOutputLine,
};
