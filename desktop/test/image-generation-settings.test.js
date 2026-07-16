"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadSettings,
  normalizeSettings,
  publicSettings,
  saveSettings,
} = require("../src/image-generation-settings");

test("image settings encrypt the API key and decrypt it on load", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-image-settings-"));
  const file = path.join(root, "settings.json");
  const encrypt = value => Buffer.from(`encrypted:${value}`).toString("base64");
  const decrypt = value => Buffer.from(value, "base64").toString().replace(/^encrypted:/, "");

  try {
    const saved = saveSettings(
      file,
      { baseUrl: "https://images.example/v1/", modelName: "image-model", apiKey: "secret" },
      encrypt,
    );
    const raw = fs.readFileSync(file, "utf8");

    assert.equal(raw.includes("secret"), false);
    assert.deepEqual(saved, {
      baseUrl: "https://images.example/v1",
      modelName: "image-model",
      apiKey: "secret",
    });
    assert.deepEqual(loadSettings(file, decrypt), saved);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blank API keys retain the encrypted setting already in memory", () => {
  const previous = {
    baseUrl: "https://old.example/v1",
    modelName: "old-model",
    apiKey: "existing-secret",
  };

  assert.deepEqual(
    normalizeSettings(
      { baseUrl: "https://new.example/v1/", modelName: "new-model", apiKey: "  " },
      previous,
    ),
    {
      baseUrl: "https://new.example/v1",
      modelName: "new-model",
      apiKey: "existing-secret",
    },
  );
});

test("public image settings never expose the API key", () => {
  const result = publicSettings({
    baseUrl: "https://images.example/v1",
    modelName: "image-model",
    apiKey: "secret",
  });

  assert.deepEqual(result, {
    baseUrl: "https://images.example/v1",
    modelName: "image-model",
    hasApiKey: true,
  });
  assert.equal(Object.hasOwn(result, "apiKey"), false);
});

test("incomplete image settings are rejected", () => {
  assert.throws(
    () => saveSettings("unused.json", { baseUrl: "", modelName: "model", apiKey: "key" }, String),
    /请完整填写/,
  );
});
