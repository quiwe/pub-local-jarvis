"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSettings, saveSettings } = require("../src/game-profiles");

test("game profiles default to the built-in Minecraft profile", () => {
  const settings = loadSettings(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
  assert.equal(settings.selectedId, "minecraft");
  assert.equal(settings.profiles[0].name, "我的世界");
  assert.equal(settings.profiles[0].builtIn, true);
});

test("selected profile and edited prompts persist", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-game-profiles-"));
  const file = path.join(directory, "profiles.json");
  const settings = loadSettings(file);
  settings.profiles[0].prompt = "自定义我的世界提示词";
  settings.profiles.push({ id: "custom-game", name: "测试游戏", prompt: "测试提示词", builtIn: false });
  settings.selectedId = "custom-game";
  saveSettings(file, settings);

  const loaded = loadSettings(file);
  assert.equal(loaded.selectedId, "custom-game");
  assert.equal(loaded.profiles[0].prompt, "自定义我的世界提示词");
  assert.equal(loaded.profiles[1].name, "测试游戏");
  fs.rmSync(directory, { recursive: true, force: true });
});
