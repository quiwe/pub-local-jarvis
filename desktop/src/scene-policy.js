"use strict";

function resolveDisplayScene(reportedScene) {
  return ["game", "course", "other"].includes(reportedScene) ? reportedScene : "other";
}

module.exports = { resolveDisplayScene };
