"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { presentBarrageWindow } = require("../src/barrage-overlay");

test("presenting the barrage restores its fullscreen topmost overlay state", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    setBounds: (...args) => calls.push(["setBounds", ...args]),
    setAlwaysOnTop: (...args) => calls.push(["setAlwaysOnTop", ...args]),
    setVisibleOnAllWorkspaces: (...args) => calls.push(["setVisibleOnAllWorkspaces", ...args]),
    setIgnoreMouseEvents: (...args) => calls.push(["setIgnoreMouseEvents", ...args]),
    showInactive: () => calls.push(["showInactive"]),
    moveTop: () => calls.push(["moveTop"]),
  };
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };

  assert.equal(presentBarrageWindow(window, bounds), true);
  assert.deepEqual(calls, [
    ["setBounds", bounds, false],
    ["setAlwaysOnTop", true, "screen-saver", 1],
    ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
    ["setIgnoreMouseEvents", true],
    ["showInactive"],
    ["moveTop"],
  ]);
});

test("a destroyed barrage window is ignored", () => {
  assert.equal(presentBarrageWindow({ isDestroyed: () => true }), false);
});
