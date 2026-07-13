"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDisplayScene } = require("../src/scene-policy");

test("an active course keeps the pet in course mode across noisy scene results", () => {
  assert.equal(resolveDisplayScene("course", true), "course");
  assert.equal(resolveDisplayScene("other", true), "course");
  assert.equal(resolveDisplayScene("game", true), "course");
});

test("reported scenes apply normally after the course finishes", () => {
  assert.equal(resolveDisplayScene("game", false), "game");
  assert.equal(resolveDisplayScene("other", false), "other");
  assert.equal(resolveDisplayScene("invalid", false), "other");
});
