"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPetPointerInteractive } = require("../src/pet-hit-test");

test("pet body accepts mouse input for native dragging", () => {
  assert.equal(isPetPointerInteractive(300, 210, 390, 300, false), true);
  assert.equal(isPetPointerInteractive(100, 200, 390, 300, false), false);
});

test("bubble accepts input only while it is visible", () => {
  assert.equal(isPetPointerInteractive(100, 60, 390, 300, true), true);
  assert.equal(isPetPointerInteractive(100, 60, 390, 300, false), false);
});
