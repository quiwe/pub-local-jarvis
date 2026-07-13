"use strict";

function resolveDisplayScene(reportedScene, courseActive) {
  const scene = ["game", "course", "other"].includes(reportedScene) ? reportedScene : "other";
  return courseActive ? "course" : scene;
}

module.exports = { resolveDisplayScene };
