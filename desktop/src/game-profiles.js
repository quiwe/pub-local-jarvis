"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const MINECRAFT_PROMPT = "领域关注：生存、建造、探索、采集、战斗或红石阶段；生命与饥饿、装备耐久、资源、时间、坐标、敌对生物和环境风险。表达风格：像熟悉《我的世界》的朋友，实用提醒与自然接梗并重。";
const PLANTS_VS_ZOMBIES_PROMPT = "领域关注：关卡地形与昼夜、波次、僵尸路线、阳光产能、植物冷却、各路火力、防线缺口、特殊威胁和割草机。建议优先处理即将破线的威胁，其次优化经济与阵型，并点明一个关键理由；稳定时可点评阵型协同。表达风格：懂游戏、轻松直接。";
const OVERCOOKED_PROMPT = "领域关注：订单与剩余时间、菜品工序、食材和厨具位置、灶台、地形及分工。建议只给当前最高优先级并说明先后顺序，优先处理超时、烧糊、缺盘缺料和动线堵塞；有余裕再谈分区与备料。表达风格：冷静有趣的队友，不指责具体玩家。";

const builtInProfiles = [
  {
    id: "minecraft",
    name: "我的世界",
    prompt: MINECRAFT_PROMPT,
    builtIn: true,
  },
  {
    id: "plants-vs-zombies",
    name: "植物大战僵尸",
    prompt: PLANTS_VS_ZOMBIES_PROMPT,
    builtIn: true,
  },
  {
    id: "overcooked",
    name: "胡闹厨房",
    prompt: OVERCOOKED_PROMPT,
    builtIn: true,
  },
];
const builtInIds = new Set(builtInProfiles.map(item => item.id));
const legacyBuiltInPromptHashes = new Map([
  ["minecraft", "862971bdd310551034a7b0f76b803c3209408c2239455280f62b5ec5977ee723"],
  ["plants-vs-zombies", "1bd91a53d89500c96bd52283ab6776ac4c42efa1947f7e75d72c49c5fe8b872e"],
  ["overcooked", "67d16cb8521475b3b0dd1ade93f2bc2fb87f73b97fc09a5cabf365f306d8a2a0"],
]);

function usesLegacyBuiltInPrompt(profile) {
  const legacyHash = legacyBuiltInPromptHashes.get(profile.id);
  if (!legacyHash) return false;
  return crypto.createHash("sha256").update(profile.prompt, "utf8").digest("hex") === legacyHash;
}

function normalizeProfile(value, builtIn = false) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 80);
  const name = String(value.name || "").trim().slice(0, 40);
  const prompt = String(value.prompt || "").trim().slice(0, 8000);
  if (!id || !name || !prompt) return null;
  return { id, name, prompt, builtIn };
}

function defaultSettings() {
  return {
    selectedId: "minecraft",
    profiles: builtInProfiles.map(item => ({ ...item })),
    deletedBuiltInIds: [],
  };
}

function loadSettings(filePath) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {}
  const custom = Array.isArray(saved.profiles)
    ? saved.profiles.map(item => normalizeProfile(item, builtInIds.has(item?.id))).filter(Boolean)
    : [];
  const deletedBuiltInIds = new Set(
    Array.isArray(saved.deletedBuiltInIds)
      ? saved.deletedBuiltInIds.filter(id => builtInIds.has(id))
      : [],
  );
  const profiles = [
    ...builtInProfiles
      .filter(profile => !deletedBuiltInIds.has(profile.id))
      .map(profile => {
        const savedProfile = custom.find(item => item.id === profile.id);
        if (!savedProfile) return { ...profile };
        return usesLegacyBuiltInPrompt(savedProfile)
          ? { ...savedProfile, prompt: profile.prompt }
          : savedProfile;
      }),
    ...custom.filter(item => !builtInIds.has(item.id)),
  ];
  if (!profiles.length) {
    profiles.push({ ...builtInProfiles[0] });
    deletedBuiltInIds.delete(builtInProfiles[0].id);
  }
  const selectedId = profiles.some(item => item.id === saved.selectedId)
    ? saved.selectedId
    : profiles[0].id;
  return { selectedId, profiles, deletedBuiltInIds: [...deletedBuiltInIds] };
}

function saveSettings(filePath, settings) {
  const profiles = settings.profiles
    .map(item => normalizeProfile(item, builtInIds.has(item.id)))
    .filter(Boolean);
  const deletedBuiltInIds = Array.isArray(settings.deletedBuiltInIds)
    ? settings.deletedBuiltInIds.filter(id => builtInIds.has(id))
    : [];
  fs.writeFileSync(
    filePath,
    JSON.stringify({ selectedId: settings.selectedId, profiles, deletedBuiltInIds }, null, 2),
    "utf8",
  );
}

function removeProfile(settings, id) {
  const profile = settings.profiles.find(item => item.id === id);
  if (!profile) throw new Error("游戏陪伴方案不存在");
  if (settings.profiles.length <= 1) throw new Error("至少保留一个游戏陪伴方案");
  const deletedBuiltInIds = new Set(settings.deletedBuiltInIds || []);
  if (builtInIds.has(profile.id)) deletedBuiltInIds.add(profile.id);
  const profiles = settings.profiles.filter(item => item.id !== id);
  return {
    ...settings,
    profiles,
    selectedId: settings.selectedId === id ? profiles[0].id : settings.selectedId,
    deletedBuiltInIds: [...deletedBuiltInIds],
  };
}

module.exports = {
  MINECRAFT_PROMPT,
  OVERCOOKED_PROMPT,
  PLANTS_VS_ZOMBIES_PROMPT,
  defaultSettings,
  loadSettings,
  normalizeProfile,
  removeProfile,
  saveSettings,
};
