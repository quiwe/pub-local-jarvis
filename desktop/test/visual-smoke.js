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
  }));
  ipcMain.handle("jarvis:open-output", () => null);
  ipcMain.handle("jarvis:toggle-screen-privacy", () => ({
    phase: "running", monitoring: true, screenBlocked: true,
  }));

  await capture("launcher", { width: 520, height: 690, useContentSize: true }, "launcher.html");
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
