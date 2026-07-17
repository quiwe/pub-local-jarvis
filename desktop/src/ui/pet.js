"use strict";

const pet = document.querySelector("#pet");
const bubble = document.querySelector("#bubble");
const bubbleText = document.querySelector("#bubble-text");
const bubbleAction = document.querySelector("#bubble-action");
const privacyToggle = document.querySelector("#privacy-toggle");
let outputPath = null;

privacyToggle.addEventListener("dblclick", async event => {
  event.preventDefault();
  try {
    await window.jarvis.toggleScreenPrivacy();
  } catch (_) {
    // The main window reports backend command failures through its normal status path.
  }
});

window.jarvis.onPetScene(scene => {
  pet.dataset.scene = scene || "other";
});

window.jarvis.onScreenPrivacy(enabled => {
  pet.dataset.screenBlocked = enabled ? "true" : "false";
  pet.setAttribute("aria-label", enabled ? "AI 贾维斯，画面已屏蔽" : "AI 贾维斯桌宠");
});

window.jarvis.onBubble(message => {
  if (!message || !message.text) {
    bubble.hidden = true;
    outputPath = null;
    return;
  }
  bubble.dataset.tone = message.tone || "info";
  bubbleText.textContent = message.text;
  outputPath = message.outputPath || null;
  bubbleAction.hidden = !outputPath;
  bubble.hidden = false;
});

bubbleAction.addEventListener("click", () => {
  if (outputPath) window.jarvis.openOutput(outputPath);
});
