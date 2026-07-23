"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const output = path.resolve(__dirname, "..", "qa-output");
const preload = path.resolve(__dirname, "..", "src", "preload.js");
const ui = path.resolve(__dirname, "..", "src", "ui");
let privacyToggleCount = 0;

app.on("window-all-closed", () => {});

async function capture(name, options, file, prepare) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    ...options,
  });
  await window.loadFile(path.join(ui, file));
  await new Promise(resolve => setTimeout(resolve, 120));
  if (prepare) await prepare(window);
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(output, `${name}.png`), image.toPNG());
  window.destroy();
}

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const memoryImage = await fs.readFile(path.resolve(
    __dirname,
    "..",
    "..",
    "src",
    "jarvis_backend",
    "assets",
    "jarvis-style-reference.png",
  ));
  const memoryImageUrl = `data:image/png;base64,${memoryImage.toString("base64")}`;
  ipcMain.handle("jarvis:get-state", () => ({
    phase: "idle",
    monitoring: false,
    scene: "other",
    error: null,
    environmentStatus: "idle",
    gameProfile: "我的世界",
  }));
  ipcMain.handle("jarvis:get-game-profiles", () => ({
    selectedId: "minecraft",
    profiles: [
      { id: "minecraft", name: "我的世界", prompt: "关注生存、建造、探索与战斗。", builtIn: true },
      { id: "custom-demo", name: "星际探索", prompt: "关注资源、航线与舰队状态。", builtIn: false },
    ],
  }));
  ipcMain.handle("jarvis:open-output", () => null);
  ipcMain.handle("jarvis:memory-status", () => ({
    event_count: 4,
    summary: null,
    fact_count: 0,
    today: "2026-07-16",
    today_event_count: 3,
    today_generated: true,
  }));
  ipcMain.handle("jarvis:memory-days", () => ([
    { date: "2026-07-16", event_count: 3, generated: true, preview: "完成记忆系统开发" },
    { date: "2026-07-15", event_count: 1, generated: true, preview: "整理项目结构" },
  ]));
  ipcMain.handle("jarvis:memory-day", (_event, day) => ({
    date: day,
    event_count: day === "2026-07-16" ? 3 : 1,
    generated: true,
    content: `# ${day} 的记忆\n\n> 由本地模型总结于 2026-07-16 17:20。\n\n## 今日回顾\n\n09:30至11:10（约1小时40分），开发并测试 AI 贾维斯记忆系统。11:10至12:00（约50分钟），运行自动化测试并检查界面。`,
  }));
  ipcMain.handle("jarvis:memory-generate", (_event, day) => ({
    date: day, event_count: 3, generated: true, content: `# ${day} 的记忆`,
  }));
  ipcMain.handle("jarvis:memory-images", (_event, day) => ([
    {
      id: `${day}-latest`,
      date: day,
      filename: "latest.png",
      created_at: `${day}T17:25:00Z`,
      model_name: "gpt-image-1.5",
      content_url: memoryImageUrl,
    },
    {
      id: `${day}-earlier`,
      date: day,
      filename: "earlier.png",
      created_at: `${day}T16:10:00Z`,
      model_name: "gpt-image-1.5",
      content_url: memoryImageUrl,
    },
  ]));
  ipcMain.handle("jarvis:memory-image-generate", (_event, day) => ({
    id: `${day}-generated`, date: day, filename: "generated.png",
  }));
  ipcMain.handle("jarvis:image-settings-get", () => ({
    baseUrl: "https://images.example/v1",
    modelName: "gpt-image-1.5",
    hasApiKey: true,
  }));
  ipcMain.handle("jarvis:image-settings-save", (_event, value) => ({
    baseUrl: value.baseUrl,
    modelName: value.modelName,
    hasApiKey: true,
  }));
  ipcMain.handle("jarvis:toggle-screen-privacy", async () => {
    privacyToggleCount += 1;
    await new Promise(resolve => setTimeout(resolve, 250));
    return { phase: "running", monitoring: true, screenBlocked: true };
  });
  ipcMain.handle("jarvis:pet-chat", (_event, message) => ({
    reply: `我收到了：${message}`,
  }));
  ipcMain.handle("jarvis:set-pet-chat-visible", () => true);

  await capture(
    "launcher",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      const layout = await window.webContents.executeJavaScript(`(() => {
        const view = document.querySelector('#overview-view .view-scroll');
        return { scrollHeight: view.scrollHeight, clientHeight: view.clientHeight };
      })()`);
      if (layout.scrollHeight > layout.clientHeight + 1) {
        throw new Error(`overview default layout overflow: ${JSON.stringify(layout)}`);
      }
    }
  );
  await capture(
    "launcher-starting",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      window.webContents.send("jarvis:state", {
        phase: "starting",
        monitoring: false,
        scene: "other",
        error: null,
        gameProfile: "我的世界",
      });
      window.webContents.send("jarvis:progress", {
        type: "download-progress",
        message: "正在下载模型：2.65 / 6.32 GiB",
        percent: 42,
      });
      await new Promise(resolve => setTimeout(resolve, 120));
      const layout = await window.webContents.executeJavaScript(`(() => {
        const progress = document.querySelector('#startup-progress');
        const view = document.querySelector('#overview-view .view-scroll');
        return {
          hidden: progress.hidden,
          percent: document.querySelector('#startup-progress-track').getAttribute('aria-valuenow'),
          value: document.querySelector('#startup-progress-value').textContent,
          scrollHeight: view.scrollHeight,
          clientHeight: view.clientHeight,
        };
      })()`);
      if (layout.hidden || layout.percent !== "42" || layout.value !== "42%"
          || layout.scrollHeight > layout.clientHeight + 1) {
        throw new Error(`launcher progress layout failed: ${JSON.stringify(layout)}`);
      }
    }
  );
  await capture(
    "launcher-environment-initializing",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      window.webContents.send("jarvis:state", {
        phase: "running",
        monitoring: true,
        environmentStatus: "initializing",
        scene: "other",
        error: null,
        gameProfile: "我的世界",
      });
      window.webContents.send("jarvis:progress", "正在初始化环境感知模型");
      await new Promise(resolve => setTimeout(resolve, 120));
      const layout = await window.webContents.executeJavaScript(`(() => {
        const progress = document.querySelector('#startup-progress');
        const view = document.querySelector('#overview-view .view-scroll');
        return {
          hidden: progress.hidden,
          label: document.querySelector('#startup-progress-label').textContent,
          value: document.querySelector('#startup-progress-value').textContent,
          title: document.querySelector('#status-title').textContent,
          scrollHeight: view.scrollHeight,
          clientHeight: view.clientHeight,
        };
      })()`);
      if (layout.hidden || layout.label !== "正在初始化环境感知模型"
          || layout.value !== "进行中" || layout.title !== "基础监控已启动"
          || layout.scrollHeight > layout.clientHeight + 1) {
        throw new Error(`launcher environment progress failed: ${JSON.stringify(layout)}`);
      }
    }
  );
  await capture(
    "launcher-memory",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('[data-view=memory]').click()");
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await window.webContents.executeJavaScript(
        "({ view: document.querySelector('#memory-view').classList.contains('active'), days: document.querySelectorAll('.memory-day').length, title: document.querySelector('#memory-document h1')?.textContent })"
      );
      if (!state.view || state.days !== 2 || !state.title?.includes("2026-07-16")) {
        throw new Error(`memory rendering failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "launcher-memory-image",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('[data-view=memory]').click()");
      await new Promise(resolve => setTimeout(resolve, 250));
      await window.webContents.executeJavaScript("document.querySelector('[data-memory-mode=image]').click()");
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await window.webContents.executeJavaScript(`(() => {
        const image = document.querySelector('#memory-image-preview');
        return {
          visible: !document.querySelector('#memory-image-view').hidden,
          loaded: image.complete && image.naturalWidth > 0,
          history: document.querySelectorAll('.memory-image-thumb').length,
        };
      })()`);
      if (!state.visible || !state.loaded || state.history !== 2) {
        throw new Error(`memory image rendering failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "launcher-image-settings",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('#memory-image-settings').click()");
      await new Promise(resolve => setTimeout(resolve, 180));
      const state = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('#image-settings-dialog');
        const bounds = dialog.getBoundingClientRect();
        return {
          open: dialog.open,
          baseUrl: document.querySelector('#image-base-url').value,
          keyPlaceholder: document.querySelector('#image-api-key').placeholder,
          inViewport: bounds.top >= 0 && bounds.bottom <= innerHeight,
        };
      })()`);
      if (!state.open || !state.inViewport || !state.baseUrl || !state.keyPlaceholder.includes("安全保存")) {
        throw new Error(`image settings rendering failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "launcher-memory-minimum",
    { width: 480, height: 700, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('[data-view=memory]').click()");
      await new Promise(resolve => setTimeout(resolve, 250));
      await window.webContents.executeJavaScript("document.querySelector('[data-memory-mode=image]').click()");
      await new Promise(resolve => setTimeout(resolve, 120));
      const layout = await window.webContents.executeJavaScript(
        "({ body: document.body.scrollWidth, viewport: innerWidth, footer: document.querySelector('.command-bar').getBoundingClientRect().bottom, imageRight: document.querySelector('#memory-image-view').getBoundingClientRect().right, height: innerHeight })"
      );
      if (layout.body > layout.viewport || layout.footer > layout.height + 1 || layout.imageRight > layout.viewport + 1) {
        throw new Error(`memory minimum layout overflow: ${JSON.stringify(layout)}`);
      }
    }
  );
  await capture(
    "game-profile-dialog",
    { width: 520, height: 760, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('#game-profile-button').click()");
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = await window.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('#profile-select');
        const builtInDeleteEnabled = !document.querySelector('#profile-delete').disabled;
        select.value = 'custom-demo';
        select.dispatchEvent(new Event('change'));
        const bounds = document.querySelector('#game-profile-dialog').getBoundingClientRect();
        return {
          visible: document.querySelector('#game-profile-dialog').open,
          builtInDeleteEnabled,
          name: document.querySelector('#profile-name').value,
          count: document.querySelector('#profile-prompt-count').textContent,
          inViewport: bounds.top >= 0 && bounds.bottom <= innerHeight,
        };
      })()`);
      if (!state.visible || !state.inViewport || !state.builtInDeleteEnabled || state.name !== "星际探索" || !state.count.includes("13 / 8000")) {
        throw new Error(`game profile editor failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "pet-idle",
    { width: 390, height: 300, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      window.show();
      window.focus();
      const point = await window.webContents.executeJavaScript(`(() => {
        const bounds = document.querySelector('#privacy-toggle').getBoundingClientRect();
        return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
      })()`);
      for (const clickCount of [1, 2]) {
        window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount });
        window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount });
      }
      await new Promise(resolve => setTimeout(resolve, 40));
      const state = await window.webContents.executeJavaScript(
        "({ state: document.querySelector('#pet').dataset.state, loaded: document.querySelector('#pet-animation').complete && document.querySelector('#pet-animation').naturalWidth > 0 })"
      );
      if (state.state !== "closed" || !state.loaded || privacyToggleCount !== 1) {
        throw new Error(`pet idle interaction failed: ${JSON.stringify({ ...state, privacyToggleCount })}`);
      }
    }
  );
  await capture(
    "pet-chat",
    { width: 540, height: 360, frame: false, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      window.webContents.send("jarvis:pet-chat-visibility", true);
      await new Promise(resolve => setTimeout(resolve, 100));
      await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('#chat-input');
        input.value = '帮我概括一下当前任务';
        document.querySelector('#chat-form').requestSubmit();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 180));
      const state = await window.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('#pet-chat');
        const bounds = panel.getBoundingClientRect();
        return {
          visible: !panel.hidden,
          messages: document.querySelectorAll('.chat-message').length,
          petState: document.querySelector('#pet').dataset.state,
          inViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          overflow: document.body.scrollWidth > innerWidth || document.body.scrollHeight > innerHeight,
        };
      })()`);
      if (!state.visible || state.messages !== 2 || state.petState !== "normal" || !state.inViewport || state.overflow) {
        throw new Error(`pet chat rendering failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "pet-bubble",
    { width: 390, height: 300, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      window.webContents.send("jarvis:pet-scene", "course");
      window.webContents.send("jarvis:screen-privacy", true);
      window.webContents.send("jarvis:bubble", {
        text: "课程总结已经生成，已保存到桌面。",
        tone: "success",
        outputPath: "C:/Desktop/Jarvis-Courses/lesson/README.md",
      });
      await new Promise(resolve => setTimeout(resolve, 700));
      const state = await window.webContents.executeJavaScript(
        "({ api: typeof window.jarvis, hidden: document.querySelector('#bubble').hidden, petState: document.querySelector('#pet').dataset.state })"
      );
      if (state.api !== "object" || state.hidden || state.petState !== "closed") {
        throw new Error(`pet IPC rendering failed: ${JSON.stringify(state)}`);
      }
    }
  );
  await capture(
    "pet-normal",
    { width: 390, height: 300, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      const initial = await window.webContents.executeJavaScript(
        "({ state: document.querySelector('#pet').dataset.state, src: document.querySelector('#pet-animation').src })"
      );
      window.webContents.send("jarvis:bubble", { text: "我来帮你看看。", tone: "info" });
      await new Promise(resolve => setTimeout(resolve, 80));
      const firstBubble = await window.webContents.executeJavaScript(
        "({ state: document.querySelector('#pet').dataset.state, src: document.querySelector('#pet-animation').src })"
      );
      window.webContents.send("jarvis:bubble", null);
      await new Promise(resolve => setTimeout(resolve, 80));
      const afterBubble = await window.webContents.executeJavaScript(
        "({ state: document.querySelector('#pet').dataset.state, src: document.querySelector('#pet-animation').src })"
      );
      window.webContents.send("jarvis:bubble", { text: "第二条消息会重新播放普通动画。", tone: "info" });
      await new Promise(resolve => setTimeout(resolve, 80));
      const secondBubble = await window.webContents.executeJavaScript(
        "({ state: document.querySelector('#pet').dataset.state, src: document.querySelector('#pet-animation').src })"
      );
      if (
        initial.state !== "idle" ||
        firstBubble.state !== "normal" ||
        afterBubble.state !== "idle" ||
        secondBubble.state !== "normal" ||
        firstBubble.src === secondBubble.src
      ) {
        throw new Error(`pet normal replay failed: ${JSON.stringify({ initial, firstBubble, afterBubble, secondBubble })}`);
      }
    }
  );
  await capture(
    "pet-course",
    { width: 390, height: 300, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      window.webContents.send("jarvis:pet-scene", "course");
      await new Promise(resolve => setTimeout(resolve, 80));
      const course = await window.webContents.executeJavaScript(
        "document.querySelector('#pet').dataset.state"
      );
      window.webContents.send("jarvis:bubble", { text: "课程中的临时提示。", tone: "course" });
      await new Promise(resolve => setTimeout(resolve, 80));
      const bubbleState = await window.webContents.executeJavaScript(
        "document.querySelector('#pet').dataset.state"
      );
      window.webContents.send("jarvis:bubble", null);
      await new Promise(resolve => setTimeout(resolve, 80));
      const restored = await window.webContents.executeJavaScript(
        "document.querySelector('#pet').dataset.state"
      );
      if (course !== "course" || bubbleState !== "normal" || restored !== "course") {
        throw new Error(`pet course transitions failed: ${JSON.stringify({ course, bubbleState, restored })}`);
      }
    }
  );
  await capture(
    "pet-idle-reminder",
    { width: 390, height: 300, backgroundColor: "#d8dfdd" },
    "pet.html",
    async window => {
      window.webContents.send("jarvis:pet-scene", "other");
      window.webContents.send("jarvis:bubble", {
        text: "画面好久没动了，主人是在发呆吗？",
        tone: "idle",
        duration: 9000,
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      const tone = await window.webContents.executeJavaScript(
        "document.querySelector('#bubble').dataset.tone"
      );
      if (tone !== "idle") throw new Error("idle reminder rendering failed");
    }
  );
  await capture(
    "barrage",
    { width: 1280, height: 720, backgroundColor: "#263332" },
    "barrage.html",
    async window => {
      await window.webContents.executeJavaScript("document.body.style.background='#263332'");
      window.webContents.send("jarvis:barrage", "时机抓得很准！");
      await new Promise(resolve => setTimeout(resolve, 2200));
      const count = await window.webContents.executeJavaScript(
        "document.querySelectorAll('.barrage-line').length"
      );
      if (count !== 1) throw new Error("barrage IPC rendering failed");
    }
  );
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
