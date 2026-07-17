"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { displayForWindow, sourceForDisplay } = require("../src/pet-display");

test("selects the display containing the pet window", () => {
  const secondary = { id: 27, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const screen = {
    getDisplayMatching(bounds) {
      assert.deepEqual(bounds, { x: 2200, y: 700, width: 390, height: 300 });
      return secondary;
    },
    getPrimaryDisplay() {
      throw new Error("primary display should not be used");
    },
  };
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 2200, y: 700, width: 390, height: 300 }),
  };

  assert.equal(displayForWindow(screen, window), secondary);
});

test("falls back to the primary display when the pet window is unavailable", () => {
  const primary = { id: 1 };
  const screen = {
    getDisplayMatching() {
      throw new Error("destroyed window should not be inspected");
    },
    getPrimaryDisplay: () => primary,
  };

  assert.equal(displayForWindow(screen, { isDestroyed: () => true }), primary);
});

test("matches desktop capture sources by display id without cross-screen fallback", () => {
  const sources = [
    { display_id: "1", name: "primary" },
    { display_id: "27", name: "secondary" },
  ];

  assert.equal(sourceForDisplay(sources, { id: 27 }), sources[1]);
  assert.equal(sourceForDisplay(sources, { id: 99 }), null);
});
