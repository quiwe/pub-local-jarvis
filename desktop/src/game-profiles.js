"use strict";

const fs = require("node:fs");

const MINECRAFT_PROMPT = "你正在陪伴用户游玩《我的世界》。结合画面判断生存、建造、探索、采集、战斗或红石等阶段，优先关注生命与饥饿、装备耐久、资源、时间、坐标、敌对生物和环境风险。弹幕要像熟悉游戏的朋友：信息明确时给简短实用的提醒，精彩或失误时自然接梗；不要虚构版本机制、物品或画面外事件，不确定时只对局势作保留式回应。";

const builtInProfiles = [{
  id: "minecraft",
  name: "我的世界",
  prompt: MINECRAFT_PROMPT,
  builtIn: true,
}];

function normalizeProfile(value, builtIn = false) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 80);
  const name = String(value.name || "").trim().slice(0, 40);
  const prompt = String(value.prompt || "").trim().slice(0, 8000);
  if (!id || !name || !prompt) return null;
  return { id, name, prompt, builtIn };
}

function defaultSettings() {
  return { selectedId: "minecraft", profiles: builtInProfiles.map(item => ({ ...item })) };
}

function loadSettings(filePath) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {}
  const custom = Array.isArray(saved.profiles)
    ? saved.profiles.map(item => normalizeProfile(item, item?.id === "minecraft")).filter(Boolean)
    : [];
  const minecraft = custom.find(item => item.id === "minecraft") || { ...builtInProfiles[0] };
  const profiles = [minecraft, ...custom.filter(item => item.id !== "minecraft")];
  const selectedId = profiles.some(item => item.id === saved.selectedId) ? saved.selectedId : "minecraft";
  return { selectedId, profiles };
}

function saveSettings(filePath, settings) {
  const profiles = settings.profiles
    .map(item => normalizeProfile(item, item.id === "minecraft"))
    .filter(Boolean);
  fs.writeFileSync(filePath, JSON.stringify({ selectedId: settings.selectedId, profiles }, null, 2), "utf8");
}

module.exports = { MINECRAFT_PROMPT, defaultSettings, loadSettings, normalizeProfile, saveSettings };
