"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const subscribe = channel => callback => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("jarvis", {
  start: () => ipcRenderer.invoke("jarvis:start"),
  cancelStart: () => ipcRenderer.invoke("jarvis:cancel-start"),
  pause: () => ipcRenderer.invoke("jarvis:pause"),
  resume: () => ipcRenderer.invoke("jarvis:resume"),
  openConsole: () => ipcRenderer.invoke("jarvis:open-console"),
  openOutput: outputPath => ipcRenderer.invoke("jarvis:open-output", outputPath),
  getState: () => ipcRenderer.invoke("jarvis:get-state"),
  toggleScreenPrivacy: () => ipcRenderer.invoke("jarvis:toggle-screen-privacy"),
  reportPetPointer: interactive => ipcRenderer.send("jarvis:pet-pointer", !!interactive),
  onState: subscribe("jarvis:state"),
  onProgress: subscribe("jarvis:progress"),
  onPetScene: subscribe("jarvis:pet-scene"),
  onScreenPrivacy: subscribe("jarvis:screen-privacy"),
  onBubble: subscribe("jarvis:bubble"),
  onBarrage: subscribe("jarvis:barrage"),
});
