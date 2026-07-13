"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  OVERCOOKED_PROMPT,
  PLANTS_VS_ZOMBIES_PROMPT,
  loadSettings,
  saveSettings,
} = require("../src/game-profiles");

test("game profiles include all built-in profiles", () => {
  const settings = loadSettings(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
  assert.equal(settings.selectedId, "minecraft");
  assert.deepEqual(settings.profiles.map(profile => profile.name), ["我的世界", "植物大战僵尸", "胡闹厨房"]);
  assert.equal(settings.profiles.every(profile => profile.builtIn), true);
  assert.match(PLANTS_VS_ZOMBIES_PROMPT, /阳光储备与产能/);
  assert.match(OVERCOOKED_PROMPT, /只给一个最高优先级/);
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
  assert.equal(loaded.profiles.find(profile => profile.id === "custom-game").name, "测试游戏");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("new built-in profiles are added to settings saved by older versions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-game-profiles-"));
  const file = path.join(directory, "profiles.json");
  fs.writeFileSync(file, JSON.stringify({
    selectedId: "minecraft",
    profiles: [{ id: "minecraft", name: "我的世界", prompt: "保留旧提示词", builtIn: true }],
  }), "utf8");

  const loaded = loadSettings(file);
  assert.deepEqual(loaded.profiles.map(profile => profile.id), ["minecraft", "plants-vs-zombies", "overcooked"]);
  assert.equal(loaded.profiles[0].prompt, "保留旧提示词");
  fs.rmSync(directory, { recursive: true, force: true });
});
