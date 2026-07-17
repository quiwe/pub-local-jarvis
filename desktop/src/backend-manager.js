"use strict";

const { EventEmitter } = require("node:events");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class StartCancelledError extends Error {
  constructor() {
    super("启动已取消");
    this.name = "StartCancelledError";
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new StartCancelledError();
}

function backendLaunchSpec(backendRoot, useFake) {
  if (useFake) {
    return {
      executable: path.join(backendRoot, ".venv", "Scripts", "jarvis-backend.exe"),
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

  async start(options = {}) {
    const { signal } = options;
    throwIfCancelled(signal);
    if (await this.health(signal)) {
      throwIfCancelled(signal);
      this.emit("progress", "检测到正在运行的后端，正在连接");
      this.connectEvents();
      return { owned: false };
    }
    this.emit("progress", this.useFake ? "正在启动开发后端" : "正在准备本地模型与运行环境");
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
        this.connectEvents();
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
    const { executable, args } = backendLaunchSpec(this.backendRoot, this.useFake);
    this.child = spawn(executable, args, {
      cwd: this.backendRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = chunk => {
      const text = chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (text) this.emit("progress", text.split(/\r?\n/).at(-1));
    };
    this.child.stdout.on("data", forward);
    this.child.stderr.on("data", forward);
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

  command(command, argumentsValue = {}) {
    return this.request("/api/v1/commands", {
      method: "POST",
      body: JSON.stringify({ command, arguments: argumentsValue }),
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
        await this.command("shutdown");
      } catch (_) {}
      await delay(800);
      await this.terminateChildTree();
    }
    this.ownsBackend = false;
  }
}

module.exports = { BackendManager, StartCancelledError, backendLaunchSpec };
