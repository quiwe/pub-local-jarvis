"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const output = path.resolve(__dirname, "..", "assets", "icon.png");
  const window = new BrowserWindow({ width: 256, height: 256, useContentSize: true, show: false });
  await window.loadFile(path.resolve(__dirname, "..", "src", "ui", "app-icon.html"));
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 200));
  const image = await window.webContents.capturePage();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, image.toPNG());
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
