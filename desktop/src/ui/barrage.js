"use strict";

const layer = document.querySelector("#barrage-layer");
const lanes = [0, 0, 0, 0, 0];

window.jarvis.onBarrage(text => {
  if (!text) return;
  const now = Date.now();
  let lane = lanes.findIndex(available => available <= now);
  if (lane < 0) lane = lanes.indexOf(Math.min(...lanes));
  lanes[lane] = now + 1500;
  const item = document.createElement("div");
  item.className = "barrage-line";
  item.style.top = `${8 + lane * 9}%`;
  item.textContent = text;
  layer.appendChild(item);
  item.addEventListener("animationend", () => item.remove(), { once: true });
});
