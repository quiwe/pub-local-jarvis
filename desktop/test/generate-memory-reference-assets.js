"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const output = path.resolve(__dirname, "..", "..", "src", "jarvis_backend", "assets");

app.on("window-all-closed", () => {});

async function capture(file, destination, options = {}, prepare) {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    transparent: options.transparent === true,
    backgroundColor: options.transparent ? "#00000000" : "#edf2ef",
    webPreferences: options.webPreferences || {},
  });
  await window.loadFile(file);
  if (prepare) await prepare(window);
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 700));
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(output, destination), image.toPNG());
  window.destroy();
}

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await capture(
    path.resolve(__dirname, "memory-character-reference.html"),
    "jarvis-character-reference.png",
    { transparent: true }
  );
  await capture(
    path.resolve(__dirname, "memory-style-reference.html"),
    "jarvis-style-reference.png"
  );
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
