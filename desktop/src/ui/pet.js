"use strict";

const pet = document.querySelector("#pet");
const bubble = document.querySelector("#bubble");
const bubbleText = document.querySelector("#bubble-text");
const bubbleAction = document.querySelector("#bubble-action");
const privacyToggle = document.querySelector("#privacy-toggle");
const petAnimation = document.querySelector("#pet-animation");
const { PET_ANIMATIONS, resolvePetState } = window.JarvisPetState;
let outputPath = null;
let animationSequence = 0;
let activePetState = null;
const petContext = {
  scene: "other",
  screenBlocked: false,
  bubbleVisible: false,
};

function syncPetAnimation({ replayNormal = false } = {}) {
  const nextState = resolvePetState(petContext);
  if (nextState === activePetState && !(replayNormal && nextState === "normal")) return;
  activePetState = nextState;
  pet.dataset.state = nextState;
  petAnimation.src = `${PET_ANIMATIONS[nextState]}?play=${++animationSequence}`;
}

privacyToggle.addEventListener("dblclick", async event => {
  event.preventDefault();
  try {
    await window.jarvis.toggleScreenPrivacy();
  } catch (_) {
    // The main window reports backend command failures through its normal status path.
  }
});

window.jarvis.onPetScene(scene => {
  petContext.scene = ["game", "course", "other"].includes(scene) ? scene : "other";
  pet.dataset.scene = petContext.scene;
  syncPetAnimation();
});

window.jarvis.onScreenPrivacy(enabled => {
  petContext.screenBlocked = Boolean(enabled);
  pet.dataset.screenBlocked = petContext.screenBlocked ? "true" : "false";
  pet.setAttribute("aria-label", petContext.screenBlocked ? "AI Jarvis，画面感知已暂停" : "AI Jarvis 桌宠");
  syncPetAnimation();
});

window.jarvis.onBubble(message => {
  if (!message || !message.text) {
    bubble.hidden = true;
    petContext.bubbleVisible = false;
    outputPath = null;
    syncPetAnimation();
    return;
  }
  bubble.dataset.tone = message.tone || "info";
  bubbleText.textContent = message.text;
  outputPath = message.outputPath || null;
  bubbleAction.hidden = !outputPath;
  bubble.hidden = false;
  petContext.bubbleVisible = true;
  syncPetAnimation({ replayNormal: true });
});

bubbleAction.addEventListener("click", () => {
  if (outputPath) window.jarvis.openOutput(outputPath);
});

syncPetAnimation();
