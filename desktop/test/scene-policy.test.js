"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDisplayScene } = require("../src/scene-policy");

test("the backend stabilized scene is independent of course recording", () => {
  assert.equal(resolveDisplayScene("course"), "course");
  assert.equal(resolveDisplayScene("game"), "game");
  assert.equal(resolveDisplayScene("other"), "other");
  assert.equal(resolveDisplayScene("invalid"), "other");
});
