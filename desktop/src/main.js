"use strict";

const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require("electron");
const { BackendManager, StartCancelledError } = require("./backend-manager");
const { routeBackendEvent } = require("./event-router");
const { isPetPointerInteractive } = require("./pet-hit-test");

app.setName("AI Jarvis");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let launcherWindow = null;
let petWindow = null;
let barrageWindow = null;
let tray = null;
let manager = null;
let startPromise = null;
let startController = null;
let quitting = false;
let bubbleTimer = null;
let petHitTestTimer = null;
let petMouseInteractive = false;
let petBubbleVisible = false;
const pendingCaptures = new Set();
const state = {
  phase: "idle",
  monitoring: false,
  scene: "other",
  error: null,
};

function backendRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.resolve(__dirname, "..", "..");
}

function send(window, channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function publishState(patch = {}) {
  Object.assign(state, patch);
  send(launcherWindow, "jarvis:state", { ...state });
  updateTrayMenu();
}

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 520,
    height: 690,
    useContentSize: true,
    minWidth: 480,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4f7f6",
    title: "AI Jarvis",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  launcherWindow.loadFile(path.join(__dirname, "ui", "launcher.html"));
  launcherWindow.once("ready-to-show", () => launcherWindow.show());
  launcherWindow.on("close", event => {
    if (!quitting) {
      event.preventDefault();
      launcherWindow.hide();
    }
  });
}

function createPetWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 390;
  const height = 300;
  petWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + workArea.height - height - 12,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setMovable(true);
  petWindow.setFullScreenable(false);
  petWindow.setContentProtection(true);
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.loadFile(path.join(__dirname, "ui", "pet.html"));
  petHitTestTimer = setInterval(updatePetMouseInteraction, 50);
}

function updatePetMouseInteraction() {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  const localX = point.x - bounds.x;
  const localY = point.y - bounds.y;
  const interactive = isPetPointerInteractive(
    localX, localY, bounds.width, bounds.height, petBubbleVisible
  );
  if (interactive === petMouseInteractive) return;
  petMouseInteractive = interactive;
  petWindow.setIgnoreMouseEvents(!interactive, interactive ? undefined : { forward: true });
}

function createBarrageWindow() {
  const bounds = screen.getPrimaryDisplay().bounds;
  barrageWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  barrageWindow.setAlwaysOnTop(true, "screen-saver");
  barrageWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  barrageWindow.setIgnoreMouseEvents(true);
  barrageWindow.loadFile(path.join(__dirname, "ui", "barrage.html"));
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip("AI Jarvis");
  tray.on("double-click", () => {
    launcherWindow.show();
    launcherWindow.focus();
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制面板", click: () => launcherWindow.show() },
    { type: "separator" },
    {
      label: state.monitoring ? "暂停感知" : "继续感知",
      enabled: state.phase === "running" || state.phase === "paused",
      click: () => (state.monitoring ? pauseMonitoring() : resumeMonitoring()),
    },
    { label: "打开后端控制台", enabled: state.phase !== "idle", click: openConsole },
    { type: "separator" },
    { label: "退出 AI Jarvis", click: () => app.quit() },
  ]));
}

function setScene(sceneValue) {
  const scene = ["game", "course", "other"].includes(sceneValue) ? sceneValue : "other";
  publishState({ scene });
  send(petWindow, "jarvis:pet-scene", scene);
  if (!state.monitoring) return;
  if (scene === "game") {
    if (petWindow.isVisible()) petWindow.hide();
    barrageWindow.showInactive();
  } else {
    barrageWindow.hide();
    petWindow.showInactive();
  }
}

function showBubble(effect) {
  if (state.scene === "game") return;
  clearTimeout(bubbleTimer);
  petBubbleVisible = true;
  petWindow.showInactive();
  send(petWindow, "jarvis:bubble", effect);
  bubbleTimer = setTimeout(
    () => {
      petBubbleVisible = false;
      send(petWindow, "jarvis:bubble", null);
    },
    effect.duration || 7000
  );
}

async function captureKeyframe(effect) {
  if (!effect.id || pendingCaptures.has(effect.id)) return;
  pendingCaptures.add(effect.id);
  try {
    const display = screen.getPrimaryDisplay();
    const ratio = Math.min(1, 1280 / display.bounds.width);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.max(1, Math.round(display.bounds.width * ratio)),
        height: Math.max(1, Math.round(display.bounds.height * ratio)),
      },
    });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("无法读取屏幕缩略图");
    await manager.addKeyframe(effect.id, {
      image_base64: source.thumbnail.toPNG().toString("base64"),
      timestamp_ms: effect.timestamp_ms || 0,
      extension: "png",
      metadata: { source: "electron-desktop", note: effect.note || "" },
    });
  } catch (error) {
    send(launcherWindow, "jarvis:progress", `关键截图保存失败：${error.message}`);
  } finally {
    pendingCaptures.delete(effect.id);
  }
}

function handleBackendEvent(event) {
  for (const effect of routeBackendEvent(event)) {
    if (effect.type === "scene") setScene(effect.scene);
    if (effect.type === "bubble") showBubble(effect);
    if (effect.type === "barrage") {
      barrageWindow.showInactive();
      send(barrageWindow, "jarvis:barrage", effect.text);
    }
    if (effect.type === "capture") captureKeyframe(effect);
    if (effect.type === "fault") {
      publishState({ phase: "error", monitoring: false, error: effect.text });
      showBubble({ text: effect.text, tone: "error", duration: 10000 });
    }
  }
}

async function startJarvis() {
  if (state.phase === "running") return { ...state };
  if (startPromise) return startPromise;
  startPromise = (async () => {
    startController = new AbortController();
    publishState({ phase: "starting", error: null });
    try {
      await manager.start({ signal: startController.signal });
      await manager.command("start_monitoring");
      publishState({ phase: "running", monitoring: true, error: null });
      setScene("other");
      showBubble({ text: "AI 贾维斯已启动，正在持续理解当前画面。", tone: "success" });
      setTimeout(() => launcherWindow.hide(), 900);
      if (process.env.JARVIS_DESKTOP_DEMO === "1") runDemo();
      return { ...state };
    } catch (error) {
      if (error instanceof StartCancelledError || startController.signal.aborted) {
        publishState({ phase: "idle", monitoring: false, error: null });
        return { ...state };
      }
      publishState({ phase: "error", monitoring: false, error: error.message });
      launcherWindow.show();
      throw error;
    } finally {
      startController = null;
      startPromise = null;
    }
  })();
  return startPromise;
}

async function cancelStart() {
  if (state.phase !== "starting" || !startController) return { ...state };
  startController.abort();
  await manager.cancelStart();
  send(launcherWindow, "jarvis:progress", "启动已取消");
  publishState({ phase: "idle", monitoring: false, error: null });
  return { ...state };
}

async function pauseMonitoring() {
  if (!state.monitoring) return { ...state };
  await manager.command("pause_monitoring");
  barrageWindow.hide();
  petWindow.hide();
  publishState({ phase: "paused", monitoring: false });
  return { ...state };
}

async function resumeMonitoring() {
  if (state.phase === "idle") return startJarvis();
  await manager.command("resume_monitoring");
  publishState({ phase: "running", monitoring: true });
  setScene(state.scene);
  return { ...state };
}

function openConsole() {
  return shell.openExternal("http://127.0.0.1:8000/");
}

function runDemo() {
  setTimeout(() => handleBackendEvent({ topic: "assistant.message", payload: { text: "下载任务已经完成，文件可以直接使用。" } }), 1200);
  setTimeout(() => handleBackendEvent({ topic: "perception.completed", payload: { scene: "game" } }), 5500);
  setTimeout(() => handleBackendEvent({ topic: "barrage.generated", payload: { text: "时机抓得很准！" } }), 6000);
  setTimeout(() => handleBackendEvent({ topic: "perception.completed", payload: { scene: "course" } }), 10500);
  setTimeout(() => showBubble({ text: "正在记录课程要点和关键画面。", tone: "course" }), 10800);
}

function registerIpc() {
  ipcMain.handle("jarvis:start", startJarvis);
  ipcMain.handle("jarvis:cancel-start", cancelStart);
  ipcMain.handle("jarvis:pause", pauseMonitoring);
  ipcMain.handle("jarvis:resume", resumeMonitoring);
  ipcMain.handle("jarvis:open-console", openConsole);
  ipcMain.handle("jarvis:get-state", () => ({ ...state }));
  ipcMain.handle("jarvis:open-output", async (_event, outputPath) => {
    if (typeof outputPath === "string" && outputPath) shell.showItemInFolder(outputPath);
  });
  ipcMain.on("jarvis:pet-pointer", (event, interactive) => {
    if (!petWindow || event.sender !== petWindow.webContents) return;
    petWindow.setIgnoreMouseEvents(!interactive, interactive ? undefined : { forward: true });
  });
}

app.whenReady().then(() => {
  const useFake = process.env.JARVIS_DESKTOP_USE_FAKE === "1";
  manager = new BackendManager({ backendRoot: backendRoot(), useFake });
  manager.on("progress", message => send(launcherWindow, "jarvis:progress", message));
  manager.on("event", handleBackendEvent);
  manager.on("error", error => publishState({ phase: "error", error: error.message }));
  createLauncherWindow();
  createPetWindow();
  createBarrageWindow();
  createTray();
  registerIpc();
});

app.on("activate", () => launcherWindow && launcherWindow.show());
app.on("window-all-closed", () => {});
app.on("before-quit", event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearInterval(petHitTestTimer);
  Promise.resolve(manager && manager.stop()).finally(() => {
    if (tray) tray.destroy();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.quit();
  });
});
