"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { moveWithinWorkArea, resizeAroundBottomRight } = require("../src/pet-window");

test("expanding the pet window preserves its bottom-right anchor", () => {
  assert.deepEqual(
    resizeAroundBottomRight(
      { x: 1512, y: 768, width: 390, height: 300 },
      540,
      360,
      { x: 0, y: 0, width: 1920, height: 1080 }
    ),
    { x: 1362, y: 708, width: 540, height: 360 }
  );
});

test("dragging keeps the complete pet window on its current display", () => {
  assert.deepEqual(
    moveWithinWorkArea(
      { x: 2100, y: 700, width: 390, height: 300 },
      -500,
      500,
      { x: 1920, y: 0, width: 1920, height: 1040 }
    ),
    { x: 1920, y: 740, width: 390, height: 300 }
  );
});
