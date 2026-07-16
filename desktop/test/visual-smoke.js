"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const output = path.resolve(__dirname, "..", "qa-output");
const preload = path.resolve(__dirname, "..", "src", "preload.js");
const ui = path.resolve(__dirname, "..", "src", "ui");

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
  ipcMain.handle("jarvis:get-state", () => ({
    phase: "idle",
    monitoring: false,
    scene: "other",
    error: null,
    gameProfile: "我的世界",
  }));
  ipcMain.handle("jarvis:get-game-profiles", () => ({
    selectedId: "minecraft",
    profiles: [{ id: "minecraft", name: "我的世界", prompt: "关注生存、建造、探索与战斗。", builtIn: true }],
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
  ipcMain.handle("jarvis:toggle-screen-privacy", () => ({
    phase: "running", monitoring: true, screenBlocked: true,
  }));

  await capture("launcher", { width: 520, height: 760, useContentSize: true }, "launcher.html");
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
    "launcher-memory-minimum",
    { width: 480, height: 700, useContentSize: true },
    "launcher.html",
    async window => {
      await window.webContents.executeJavaScript("document.querySelector('[data-view=memory]').click()");
      await new Promise(resolve => setTimeout(resolve, 250));
      const layout = await window.webContents.executeJavaScript(
        "({ body: document.body.scrollWidth, viewport: innerWidth, footer: document.querySelector('.command-bar').getBoundingClientRect().bottom, height: innerHeight })"
      );
      if (layout.body > layout.viewport || layout.footer > layout.height + 1) {
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
      const visible = await window.webContents.executeJavaScript("document.querySelector('#game-profile-dialog').open");
      if (!visible) throw new Error("game profile dialog did not open");
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
        "({ api: typeof window.jarvis, hidden: document.querySelector('#bubble').hidden })"
      );
      if (state.api !== "object" || state.hidden) throw new Error("pet IPC rendering failed");
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
