"use strict";

const pet = document.querySelector("#pet");
const bubble = document.querySelector("#bubble");
const bubbleText = document.querySelector("#bubble-text");
const bubbleAction = document.querySelector("#bubble-action");
let outputPath = null;
let pointerInteractive = false;

window.jarvis.onPetScene(scene => {
  pet.dataset.scene = scene || "other";
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

document.addEventListener("mousemove", event => {
  const interactive = Boolean(event.target.closest(".interactive"));
  if (interactive !== pointerInteractive) {
    pointerInteractive = interactive;
    window.jarvis.reportPetPointer(interactive);
  }
});

for (const element of [pet, bubble]) {
  element.addEventListener("mouseenter", () => {
    pointerInteractive = true;
    window.jarvis.reportPetPointer(true);
  });
}

document.addEventListener("mouseleave", () => {
  pointerInteractive = false;
  window.jarvis.reportPetPointer(false);
});
