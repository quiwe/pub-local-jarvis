"use strict";

const fs = require("node:fs");

const MINECRAFT_PROMPT = "你正在陪伴用户游玩《我的世界》。结合画面判断生存、建造、探索、采集、战斗或红石等阶段，优先关注生命与饥饿、装备耐久、资源、时间、坐标、敌对生物和环境风险。弹幕要像熟悉游戏的朋友：信息明确时给简短实用的提醒，精彩或失误时自然接梗；不要虚构版本机制、物品或画面外事件，不确定时只对局势作保留式回应。";
const PLANTS_VS_ZOMBIES_PROMPT = "你正在陪伴用户游玩《植物大战僵尸》。结合画面判断关卡地形与昼夜、当前波次、僵尸路线和阵型阶段，优先关注阳光储备与产能、植物冷却、各路火力与防线缺口、特殊僵尸威胁、割草机以及下一波压力。信息明确时给一条能立刻执行的建议，例如补经济、留阳光、针对性补防，或把一次性植物留给尸潮，并点明最关键的理由；局势稳定时可点评阵型协同、资源效率，或提出一个简短的后续优化目标。精彩反杀、阵线崩口或有趣组合出现时，像懂游戏的朋友自然接梗，但不要刷屏或只喊情绪。不要凭空认定未显示的植物、僵尸、冷却、关卡规则或未来出怪；画面不清楚时用“可能”“留意”等保留表达，避免给出会破坏阵型的武断指令。";
const OVERCOOKED_PROMPT = "你正在陪伴用户游玩《胡闹厨房》。结合画面判断订单队列、剩余时间、菜品工序、食材与厨具位置、灶台状态、厨房地形和玩家分工，优先发现即将超时或烧糊的任务、缺盘缺料、动线堵塞、空跑和重复劳动。信息明确时只给一个最高优先级、能立即执行的短建议，点明先后顺序，例如先出锅、装盘上菜、洗盘、灭火或为下一单备料；有余裕时再建议分区站位、流水线分工、交接点、批量备料或按订单顺序排程。救回险单、默契配合或厨房失控时可以自然接梗，语气像冷静又有趣的队友，不指责具体玩家，也不要连续发号施令。不要臆测画面外的订单、食材、队友意图或版本机制；看不清时只提醒可确认的风险，单人模式下也不要虚构队友。";

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
    ? saved.profiles.map(item => normalizeProfile(item, builtInIds.has(item?.id))).filter(Boolean)
    : [];
  const profiles = [
    ...builtInProfiles.map(profile => custom.find(item => item.id === profile.id) || { ...profile }),
    ...custom.filter(item => !builtInIds.has(item.id)),
  ];
  const selectedId = profiles.some(item => item.id === saved.selectedId) ? saved.selectedId : "minecraft";
  return { selectedId, profiles };
}

function saveSettings(filePath, settings) {
  const profiles = settings.profiles
    .map(item => normalizeProfile(item, builtInIds.has(item.id)))
    .filter(Boolean);
  fs.writeFileSync(filePath, JSON.stringify({ selectedId: settings.selectedId, profiles }, null, 2), "utf8");
}

module.exports = {
  MINECRAFT_PROMPT,
  OVERCOOKED_PROMPT,
  PLANTS_VS_ZOMBIES_PROMPT,
  defaultSettings,
  loadSettings,
  normalizeProfile,
  saveSettings,
};
