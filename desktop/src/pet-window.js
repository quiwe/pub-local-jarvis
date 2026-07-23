"use strict";

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function resizeAroundBottomRight(bounds, width, height, workArea) {
  return {
    x: clamp(bounds.x + bounds.width - width, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y + bounds.height - height, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function moveWithinWorkArea(bounds, deltaX, deltaY, workArea) {
  return {
    ...bounds,
    x: clamp(bounds.x + deltaX, workArea.x, workArea.x + workArea.width - bounds.width),
    y: clamp(bounds.y + deltaY, workArea.y, workArea.y + workArea.height - bounds.height),
  };
}

module.exports = { moveWithinWorkArea, resizeAroundBottomRight };
