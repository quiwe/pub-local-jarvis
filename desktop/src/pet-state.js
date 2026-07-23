"use strict";

(function exposePetState(root) {
  const PET_ANIMATIONS = Object.freeze({
    closed: "../../assets/pet/closed-eyes.gif",
    normal: "../../assets/pet/normal.gif",
    idle: "../../assets/pet/idle.gif",
    course: "../../assets/pet/course.gif",
  });

  function resolvePetState({
    screenBlocked = false,
    bubbleVisible = false,
    chatVisible = false,
    scene = "other",
  } = {}) {
    if (screenBlocked) return "closed";
    if (bubbleVisible || chatVisible) return "normal";
    if (scene === "course") return "course";
    return "idle";
  }

  const api = { PET_ANIMATIONS, resolvePetState };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JarvisPetState = api;
})(typeof globalThis === "object" ? globalThis : window);
