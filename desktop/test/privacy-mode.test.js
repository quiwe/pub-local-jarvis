"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PRIVACY_MESSAGES,
  randomPrivacyDelay,
  randomPrivacyMessage,
} = require("../src/privacy-mode");

test("privacy reminders use a random delay between 25 and 55 seconds", () => {
  assert.equal(randomPrivacyDelay(() => 0), 25_000);
  assert.equal(randomPrivacyDelay(() => 0.999999), 55_000);
});

test("privacy reminder selection stays inside the configured messages", () => {
  assert.equal(randomPrivacyMessage(() => 0), PRIVACY_MESSAGES[0]);
  assert.equal(randomPrivacyMessage(() => 0.999999), PRIVACY_MESSAGES.at(-1));
});
