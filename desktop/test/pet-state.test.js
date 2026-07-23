"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { PET_ANIMATIONS, resolvePetState } = require("../src/pet-state");

test("pet state priority is privacy, conversation, course, then idle", () => {
  assert.equal(resolvePetState(), "idle");
  assert.equal(resolvePetState({ scene: "course" }), "course");
  assert.equal(resolvePetState({ scene: "course", bubbleVisible: true }), "normal");
  assert.equal(resolvePetState({ bubbleVisible: true }), "normal");
  assert.equal(resolvePetState({ scene: "course", chatVisible: true }), "normal");
  assert.equal(resolvePetState({
    scene: "course",
    bubbleVisible: true,
    screenBlocked: true,
  }), "closed");
});

test("every pet state has a packaged GIF that plays only once", () => {
  assert.deepEqual(Object.keys(PET_ANIMATIONS).sort(), ["closed", "course", "idle", "normal"]);
  for (const [state, relativePath] of Object.entries(PET_ANIMATIONS)) {
    const assetPath = path.resolve(__dirname, "..", "src", "ui", relativePath);
    const bytes = fs.readFileSync(assetPath);
    assert.match(bytes.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/, `${state} is not a GIF`);
    assert.equal(bytes.includes(Buffer.from("NETSCAPE2.0", "ascii")), false, `${state} still loops`);
    assert.equal(bytes.includes(Buffer.from("ANIMEXTS1.0", "ascii")), false, `${state} still loops`);
  }
});
