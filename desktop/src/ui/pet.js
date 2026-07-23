"use strict";

const pet = document.querySelector("#pet");
const bubble = document.querySelector("#bubble");
const bubbleText = document.querySelector("#bubble-text");
const bubbleAction = document.querySelector("#bubble-action");
const privacyToggle = document.querySelector("#privacy-toggle");
const petAnimation = document.querySelector("#pet-animation");
const chat = document.querySelector("#pet-chat");
const chatClose = document.querySelector("#chat-close");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatSend = document.querySelector("#chat-send");
const chatMessages = document.querySelector("#chat-messages");
const { PET_ANIMATIONS, resolvePetState } = window.JarvisPetState;
let outputPath = null;
let animationSequence = 0;
let activePetState = null;
const petContext = {
  scene: "other",
  screenBlocked: false,
  bubbleVisible: false,
  chatVisible: false,
};
let dragPointerId = null;
let dragOrigin = null;
let dragging = false;

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

pet.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  dragPointerId = event.pointerId;
  dragOrigin = { x: event.screenX, y: event.screenY };
  dragging = false;
});

pet.addEventListener("pointermove", event => {
  if (event.pointerId !== dragPointerId || !dragOrigin || dragging) return;
  if (Math.hypot(event.screenX - dragOrigin.x, event.screenY - dragOrigin.y) < 4) return;
  dragging = true;
  pet.dataset.dragging = "true";
  pet.setPointerCapture(event.pointerId);
  window.jarvis.startPetDrag();
});

function finishPetDrag(event) {
  if (event && event.pointerId !== dragPointerId) return;
  if (dragging) window.jarvis.stopPetDrag();
  if (dragPointerId !== null && pet.hasPointerCapture(dragPointerId)) {
    pet.releasePointerCapture(dragPointerId);
  }
  dragPointerId = null;
  dragOrigin = null;
  dragging = false;
  delete pet.dataset.dragging;
}

pet.addEventListener("pointerup", finishPetDrag);
pet.addEventListener("pointercancel", finishPetDrag);
window.addEventListener("blur", () => finishPetDrag());

function setChatVisible(visible) {
  petContext.chatVisible = Boolean(visible);
  document.body.dataset.chatOpen = petContext.chatVisible ? "true" : "false";
  chat.hidden = !petContext.chatVisible;
  syncPetAnimation({ replayNormal: petContext.chatVisible });
  if (petContext.chatVisible) requestAnimationFrame(() => chatInput.focus());
}

function appendChatMessage(role, text, state = "ready") {
  const message = document.createElement("article");
  message.className = `chat-message ${role}`;
  message.dataset.state = state;
  const label = document.createElement("span");
  label.className = "chat-role";
  label.textContent = role === "user" ? "你" : "JARVIS";
  const content = document.createElement("p");
  content.textContent = text;
  message.append(label, content);
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

chatForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message || chatForm.dataset.busy === "true") return;
  appendChatMessage("user", message);
  chatInput.value = "";
  chatForm.dataset.busy = "true";
  chatSend.disabled = true;
  chatInput.disabled = true;
  const responseMessage = appendChatMessage("assistant", "思考中", "pending");
  try {
    const response = await window.jarvis.chat(message);
    responseMessage.dataset.state = "ready";
    responseMessage.querySelector("p").textContent = response.reply;
  } catch (error) {
    responseMessage.dataset.state = "error";
    responseMessage.querySelector("p").textContent = error.message || "回复失败，请稍后重试";
  } finally {
    delete chatForm.dataset.busy;
    chatSend.disabled = false;
    chatInput.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatInput.focus();
  }
});

chatInput.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

chatClose.addEventListener("click", () => window.jarvis.setPetChatVisible(false));
window.addEventListener("keydown", event => {
  if (event.key === "Escape" && petContext.chatVisible) {
    event.preventDefault();
    window.jarvis.setPetChatVisible(false);
  }
});

window.jarvis.onPetChatVisibility(setChatVisible);

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
