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
  safeStorage,
  screen,
  shell,
} = require("electron");
const { BackendManager, StartCancelledError } = require("./backend-manager");
const { presentBarrageWindow } = require("./barrage-overlay");
const { routeBackendEvent } = require("./event-router");
const { displayForWindow, sourceForDisplay } = require("./pet-display");
const { isPetPointerInteractive } = require("./pet-hit-test");
const { randomPrivacyDelay, randomPrivacyMessage } = require("./privacy-mode");
const { resolveDisplayScene } = require("./scene-policy");
const { defaultSettings, loadSettings, normalizeProfile, saveSettings } = require("./game-profiles");
const {
  loadSettings: loadImageSettings,
  normalizeSettings: normalizeImageSettings,
  publicSettings: publicImageSettings,
  saveSettings: saveImageSettings,
} = require("./image-generation-settings");

app.setName("AI Jarvis");
app.commandLine.appendSwitch("disable-background-timer-throttling");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.exit(0);

let launcherWindow = null;
let petWindow = null;
let barrageWindow = null;
let tray = null;
let manager = null;
let startPromise = null;
let startController = null;
let privacyTogglePromise = null;
let quitting = false;
let bubbleTimer = null;
let privacyMessageTimer = null;
let petHitTestTimer = null;
let petMouseInteractive = false;
let petBubbleVisible = false;
let gameSettings = defaultSettings();
let gameSettingsPath = "";
let imageSettingsPath = "";
let imageSettings = { baseUrl: "", modelName: "", apiKey: "" };
let activeCourseSessionId = null;
const pendingCaptures = new Set();
const state = {
  phase: "idle",
  monitoring: false,
  scene: "other",
  error: null,
  screenBlocked: false,
  gameProfile: "我的世界",
};

function selectedGameProfile() {
  return gameSettings.profiles.find(item => item.id === gameSettings.selectedId) || gameSettings.profiles[0];
}

function persistGameSettings() {
  saveSettings(gameSettingsPath, gameSettings);
  publishState({ gameProfile: selectedGameProfile().name });
}

function encryptApiKey(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法安全保存 API Key");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decryptApiKey(value) {
  if (!safeStorage.isEncryptionAvailable()) return "";
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

async function syncGameProfile() {
  const profile = selectedGameProfile();
  if (manager && (state.phase === "running" || state.phase === "paused" || state.phase === "starting")) {
    await manager.command("set_game_profile", { name: profile.name, prompt: profile.prompt });
  }
  publishState({ gameProfile: profile.name });
  return { selectedId: gameSettings.selectedId, profiles: gameSettings.profiles.map(item => ({ ...item })) };
}

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
    height: 760,
    useContentSize: true,
    minWidth: 480,
    minHeight: 700,
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
      app.quit();
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
    title: "AI Jarvis Pet",
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
  petWindow.setContentProtection(false);
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

function showBarrage(text = "") {
  if (!barrageWindow || barrageWindow.isDestroyed()) return;
  presentBarrageWindow(barrageWindow, screen.getPrimaryDisplay().bounds);
  if (text) send(barrageWindow, "jarvis:barrage", text);
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
    { type: "separator" },
    { label: "退出 AI Jarvis", click: () => app.quit() },
  ]));
}

function setScene(sceneValue) {
  const previousScene = state.scene;
  const scene = ["game", "course", "other"].includes(sceneValue) ? sceneValue : "other";
  if (scene !== previousScene && petBubbleVisible) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    petBubbleVisible = false;
    send(petWindow, "jarvis:bubble", null);
  }
  publishState({ scene });
  send(petWindow, "jarvis:pet-scene", scene);
  if (!state.monitoring) return;
  if (state.screenBlocked) {
    barrageWindow.hide();
    petWindow.showInactive();
    return;
  }
  if (scene === "game") {
    if (petWindow.isVisible()) petWindow.hide();
    showBarrage();
    if (previousScene !== "game") {
      showBarrage(`已加载《${selectedGameProfile().name}》游戏方案`);
    }
  } else {
    barrageWindow.hide();
    petWindow.showInactive();
  }
}

function showBubble(effect) {
  if (state.scene === "game") return;
  clearTimeout(bubbleTimer);
  const duration = effect.duration || Math.min(12000, Math.max(7000, effect.text.length * 180));
  petBubbleVisible = true;
  petWindow.showInactive();
  send(petWindow, "jarvis:bubble", effect);
  bubbleTimer = setTimeout(
    () => {
      petBubbleVisible = false;
      send(petWindow, "jarvis:bubble", null);
    },
    duration
  );
}

function restoreCoursePet() {
  if (
    !activeCourseSessionId ||
    state.scene !== "course" ||
    !state.monitoring ||
    state.screenBlocked ||
    !petWindow ||
    petWindow.isDestroyed()
  ) return;
  if (barrageWindow && !barrageWindow.isDestroyed()) barrageWindow.hide();
  petWindow.showInactive();
}

async function captureKeyframe(effect) {
  if (state.screenBlocked || !effect.id || pendingCaptures.has(effect.id)) return;
  pendingCaptures.add(effect.id);
  restoreCoursePet();
  try {
    const display = displayForWindow(screen, petWindow);
    const ratio = Math.min(1, 1280 / display.bounds.width);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.max(1, Math.round(display.bounds.width * ratio)),
        height: Math.max(1, Math.round(display.bounds.height * ratio)),
      },
    });
    const source = sourceForDisplay(sources, display);
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
    restoreCoursePet();
  }
}

function schedulePrivacyMessage() {
  clearTimeout(privacyMessageTimer);
  if (!state.screenBlocked) return;
  privacyMessageTimer = setTimeout(() => {
    if (!state.screenBlocked) return;
    showBubble({ text: randomPrivacyMessage(), tone: "privacy", duration: 8000 });
    schedulePrivacyMessage();
  }, randomPrivacyDelay());
}

async function toggleScreenPrivacy() {
  if (privacyTogglePromise) return privacyTogglePromise;
  if (state.phase !== "running") return { ...state };
  privacyTogglePromise = (async () => {
    const screenBlocked = !state.screenBlocked;
    await manager.command(screenBlocked ? "pause_monitoring" : "resume_monitoring");
    publishState({ screenBlocked });
    send(petWindow, "jarvis:screen-privacy", screenBlocked);
    barrageWindow.hide();
    petWindow.showInactive();
    if (screenBlocked) {
      showBubble({ text: "你在干嘛？让我看看！！", tone: "privacy", duration: 7000 });
      schedulePrivacyMessage();
    } else {
      clearTimeout(privacyMessageTimer);
      setScene(state.scene);
      showBubble({ text: "画面恢复，我又能看见了。", tone: "success", duration: 5000 });
    }
    return { ...state };
  })();
  try {
    return await privacyTogglePromise;
  } finally {
    privacyTogglePromise = null;
  }
}

function handleBackendEvent(event) {
  const payload = event && event.payload ? event.payload : {};
  if (event && (
    event.topic === "memory.activity.recorded" ||
    event.topic === "memory.day.generated" ||
    event.topic === "memory.image.generated"
  )) {
    send(launcherWindow, "jarvis:memory-updated", payload);
  }
  if (event && event.topic === "course.started") {
    activeCourseSessionId = payload.id || "active-course";
  } else if (
    event &&
    event.topic === "course.finished" &&
    (!payload.id || payload.id === activeCourseSessionId)
  ) {
    activeCourseSessionId = null;
  }
  for (const effect of routeBackendEvent(event)) {
    if (effect.type === "scene") {
      setScene(resolveDisplayScene(effect.scene));
    }
    if (effect.type === "bubble" && !state.screenBlocked) showBubble(effect);
    if (effect.type === "idle" && !state.screenBlocked) {
      if (state.scene === "game") showBarrage(effect.text);
      else showBubble(effect);
    }
    if (effect.type === "barrage") {
      if (state.scene !== "game" || state.screenBlocked) continue;
      showBarrage(effect.text);
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
      await syncGameProfile();
      await manager.command("start_monitoring");
      publishState({ phase: "running", monitoring: true, screenBlocked: false, error: null });
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
  clearTimeout(privacyMessageTimer);
  send(petWindow, "jarvis:screen-privacy", false);
  barrageWindow.hide();
  petWindow.hide();
  publishState({ phase: "paused", monitoring: false, screenBlocked: false });
  return { ...state };
}

async function resumeMonitoring() {
  if (state.phase === "idle") return startJarvis();
  await manager.command("resume_monitoring");
  publishState({ phase: "running", monitoring: true });
  setScene(state.scene);
  return { ...state };
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
  ipcMain.handle("jarvis:get-state", () => ({ ...state }));
  ipcMain.handle("jarvis:memory-status", () => manager.memoryStatus());
  ipcMain.handle("jarvis:memory-days", () => manager.memoryDays());
  ipcMain.handle("jarvis:memory-day", (_event, day) => manager.memoryDay(day));
  ipcMain.handle("jarvis:memory-generate", (_event, day) => manager.generateMemoryDay(day));
  ipcMain.handle("jarvis:memory-images", (_event, day) => manager.memoryImages(day));
  ipcMain.handle("jarvis:memory-image-generate", (_event, day) => {
    if (!imageSettings.baseUrl || !imageSettings.modelName || !imageSettings.apiKey) {
      throw new Error("请先配置生图 API");
    }
    return manager.generateMemoryImage(day, imageSettings);
  });
  ipcMain.handle("jarvis:image-settings-get", () => publicImageSettings(imageSettings));
  ipcMain.handle("jarvis:image-settings-save", (_event, value) => {
    imageSettings = saveImageSettings(
      imageSettingsPath,
      normalizeImageSettings(value, imageSettings),
      encryptApiKey,
    );
    return publicImageSettings(imageSettings);
  });
  ipcMain.handle("jarvis:get-game-profiles", () => ({
    selectedId: gameSettings.selectedId,
    profiles: gameSettings.profiles.map(item => ({ ...item })),
  }));
  ipcMain.handle("jarvis:save-game-profile", async (_event, value) => {
    const profile = normalizeProfile(value);
    if (!profile) throw new Error("游戏名称和提示词不能为空");
    const index = gameSettings.profiles.findIndex(item => item.id === profile.id);
    if (index >= 0 && gameSettings.profiles[index].builtIn) profile.builtIn = true;
    if (index >= 0) gameSettings.profiles[index] = profile;
    else gameSettings.profiles.push(profile);
    gameSettings.selectedId = profile.id;
    persistGameSettings();
    return syncGameProfile();
  });
  ipcMain.handle("jarvis:select-game-profile", async (_event, id) => {
    if (!gameSettings.profiles.some(item => item.id === id)) throw new Error("游戏陪伴方案不存在");
    gameSettings.selectedId = id;
    persistGameSettings();
    return syncGameProfile();
  });
  ipcMain.handle("jarvis:delete-game-profile", async (_event, id) => {
    const profile = gameSettings.profiles.find(item => item.id === id);
    if (!profile || profile.builtIn) throw new Error("内置方案不能删除");
    gameSettings.profiles = gameSettings.profiles.filter(item => item.id !== id);
    if (gameSettings.selectedId === id) gameSettings.selectedId = "minecraft";
    persistGameSettings();
    return syncGameProfile();
  });
  ipcMain.handle("jarvis:toggle-screen-privacy", event => {
    if (!petWindow || event.sender !== petWindow.webContents) return { ...state };
    return toggleScreenPrivacy();
  });
  ipcMain.handle("jarvis:open-output", async (_event, outputPath) => {
    if (typeof outputPath === "string" && outputPath) shell.showItemInFolder(outputPath);
  });
}

app.whenReady().then(() => {
  gameSettingsPath = path.join(app.getPath("userData"), "game-profiles.json");
  gameSettings = loadSettings(gameSettingsPath);
  imageSettingsPath = path.join(app.getPath("userData"), "image-generation.json");
  imageSettings = loadImageSettings(imageSettingsPath, decryptApiKey);
  state.gameProfile = selectedGameProfile().name;
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
app.on("second-instance", () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.show();
  launcherWindow.focus();
});
app.on("window-all-closed", () => {});
app.on("before-quit", event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearInterval(petHitTestTimer);
  clearTimeout(privacyMessageTimer);
  Promise.resolve(manager && manager.stop()).finally(() => {
    if (tray) tray.destroy();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.quit();
  });
});
