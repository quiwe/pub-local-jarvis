"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPetPointerInteractive } = require("../src/pet-hit-test");

test("pet body accepts mouse input for native dragging", () => {
  assert.equal(isPetPointerInteractive(300, 210, 390, 300, false), true);
  assert.equal(isPetPointerInteractive(240, 80, 390, 300, false), true);
  assert.equal(isPetPointerInteractive(100, 200, 390, 300, false), false);
});

test("bubble accepts input only while it is visible", () => {
  assert.equal(isPetPointerInteractive(100, 60, 390, 300, true), true);
  assert.equal(isPetPointerInteractive(100, 60, 390, 300, false), false);
  assert.equal(isPetPointerInteractive(300, 60, 390, 300, true), false);
});

test("expanded chat accepts input only inside the chat panel", () => {
  assert.equal(isPetPointerInteractive(180, 120, 540, 360, false, true), true);
  assert.equal(isPetPointerInteractive(180, 120, 540, 360, false, false), false);
  assert.equal(isPetPointerInteractive(400, 40, 540, 360, false, true), false);
});
