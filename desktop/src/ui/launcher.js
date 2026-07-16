"use strict";

const $ = selector => document.querySelector(selector);
const startButton = $("#start-button");
const pauseButton = $("#pause-button");
const phaseChip = $("#phase-chip");
const statusTitle = $("#status-title");
const statusDetail = $("#status-detail");
const monitorValue = $("#monitor-value");
const sceneValue = $("#scene-value");
const activityLog = $("#activity-log");
const gameProfileSummary = $("#game-profile-summary");
const profileDialog = $("#game-profile-dialog");
const profileForm = $("#game-profile-form");
const profileSelect = $("#profile-select");
const profileName = $("#profile-name");
const profilePrompt = $("#profile-prompt");
const profileDelete = $("#profile-delete");
const profileError = $("#profile-error");
const memoryDocument = $("#memory-document");
const memoryDays = $("#memory-days");
const memoryState = $("#memory-state");
const memoryDot = $("#memory-dot");
let currentPhase = "idle";
let currentView = "overview";
let currentMemoryDay = "";
let today = "";
let gameProfiles = [];

const sceneNames = { game: "游戏", course: "网课", other: "其他" };
const phaseView = {
  idle: ["待启动", "系统处于待命状态", "启动后将连接本地模型，持续理解屏幕与系统声音。"],
  starting: ["启动中", "正在启动本地 AI", "正在准备本地模型与运行环境。"],
  running: ["运行中", "持续感知已开启", "AI 贾维斯正在本机理解当前环境，并只在必要时介入。"],
  paused: ["已暂停", "环境感知已暂停", "屏幕和系统音频当前不会被采集。"],
  error: ["异常", "启动未完成", "请查看运行日志后重试。"],
};

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function now() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function formatDay(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function addLog(message) {
  for (const line of String(message).split(/\r?\n/).filter(Boolean).slice(-3)) {
    const item = document.createElement("p");
    const time = document.createElement("time");
    const text = document.createElement("span");
    time.textContent = now();
    text.textContent = line.length > 150 ? `${line.slice(0, 150)}...` : line;
    item.append(time, text);
    activityLog.prepend(item);
  }
  while (activityLog.children.length > 6) activityLog.lastElementChild.remove();
}

function render(state) {
  const phase = phaseView[state.phase] ? state.phase : "idle";
  currentPhase = phase;
  const [chip, title, detail] = phaseView[phase];
  document.body.className = `phase-${phase}`;
  phaseChip.textContent = chip;
  phaseChip.className = `phase-chip${phase === "running" ? " online" : phase === "error" ? " error" : ""}`;
  statusTitle.textContent = title;
  statusDetail.textContent = state.error || detail;
  monitorValue.textContent = state.monitoring ? "感知中" : phase === "paused" ? "已暂停" : "未运行";
  sceneValue.textContent = state.scene === "game" ? `游戏 · ${state.gameProfile}` : sceneNames[state.scene] || "其他";
  gameProfileSummary.textContent = `游戏方案：${state.gameProfile || "我的世界"}`;
  startButton.hidden = phase === "running" || phase === "paused";
  startButton.disabled = false;
  const startIcon = document.createElement("i");
  const startLabel = document.createElement("span");
  startIcon.setAttribute("data-lucide", phase === "starting" ? "square" : "power");
  startLabel.textContent = phase === "starting" ? "取消启动" : "启动 AI 贾维斯";
  startButton.replaceChildren(startIcon, startLabel);
  startButton.classList.toggle("cancel-command", phase === "starting");
  pauseButton.hidden = phase !== "running" && phase !== "paused";
  const pauseIcon = document.createElement("i");
  const pauseLabel = document.createElement("span");
  pauseIcon.setAttribute("data-lucide", phase === "paused" ? "play" : "pause");
  pauseLabel.textContent = phase === "paused" ? "继续感知" : "暂停感知";
  pauseButton.replaceChildren(pauseIcon, pauseLabel);
  refreshIcons();
}

function switchView(name) {
  currentView = name;
  document.querySelectorAll(".view-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === name));
  document.querySelectorAll(".app-view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  if (name === "memory") {
    memoryDot.hidden = true;
    refreshMemory();
  }
}

function setMemoryEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-memory";
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "notebook");
  const text = document.createElement("p");
  text.textContent = message;
  empty.append(icon, text);
  memoryDocument.replaceChildren(empty);
  refreshIcons();
}

function renderMarkdown(content) {
  const fragment = document.createDocumentFragment();
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let element;
    if (line.startsWith("### ")) {
      element = document.createElement("h3");
      element.textContent = line.slice(4);
    } else if (line.startsWith("## ")) {
      element = document.createElement("h2");
      element.textContent = line.slice(3);
    } else if (line.startsWith("# ")) {
      element = document.createElement("h1");
      element.textContent = line.slice(2);
    } else if (line.startsWith("> ")) {
      element = document.createElement("blockquote");
      element.textContent = line.slice(2);
    } else {
      element = document.createElement("p");
      element.textContent = line;
    }
    fragment.append(element);
  }
  memoryDocument.replaceChildren(fragment);
}

async function loadMemoryDay(day) {
  currentMemoryDay = day;
  memoryDays.querySelectorAll(".memory-day").forEach(button => button.classList.toggle("active", button.dataset.day === day));
  memoryState.textContent = "正在读取";
  try {
    const result = await window.jarvis.getMemoryDay(day);
    renderMarkdown(result.content);
    memoryState.textContent = `${formatDay(day)} · ${result.event_count} 条活动`;
  } catch (error) {
    setMemoryEmpty("这一天还没有生成记忆");
    memoryState.textContent = "暂无文档";
  }
}

function renderMemoryDays(days) {
  memoryDays.replaceChildren();
  for (const item of days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-day";
    button.dataset.day = item.date;
    const label = document.createElement("strong");
    const count = document.createElement("span");
    label.textContent = item.date === today ? "今天" : formatDay(item.date);
    count.textContent = `${item.event_count}`;
    button.append(label, count);
    button.addEventListener("click", () => item.generated ? loadMemoryDay(item.date) : generateMemory(item.date));
    memoryDays.append(button);
  }
  if (!days.length) {
    const text = document.createElement("span");
    text.className = "memory-state";
    text.textContent = "暂无历史记录";
    memoryDays.append(text);
  }
}

async function refreshMemory() {
  memoryState.textContent = "正在同步";
  try {
    const [status, days] = await Promise.all([window.jarvis.getMemoryStatus(), window.jarvis.getMemoryDays()]);
    today = status.today;
    $("#memory-today-label").textContent = formatDay(today);
    $("#memory-today-count").textContent = String(status.today_event_count);
    renderMemoryDays(days);
    const selected = days.find(item => item.date === currentMemoryDay && item.generated)
      || days.find(item => item.date === today && item.generated)
      || days.find(item => item.generated);
    if (selected) await loadMemoryDay(selected.date);
    else {
      currentMemoryDay = "";
      setMemoryEmpty(status.today_event_count ? "点击生成今日记忆" : "今天还没有可记录的活动");
      memoryState.textContent = status.today_event_count ? "已有活动等待生成" : "今日暂无记录";
    }
  } catch (error) {
    setMemoryEmpty("启动 AI 贾维斯后可查看记忆");
    memoryState.textContent = "后端未连接";
  }
}

async function generateMemory(day = today) {
  if (!day) return;
  const button = $("#memory-generate");
  button.disabled = true;
  memoryState.textContent = "正在调用本地模型归纳全天活动";
  try {
    const result = await window.jarvis.generateMemoryDay(day);
    currentMemoryDay = day;
    renderMarkdown(result.content);
    memoryState.textContent = `${formatDay(day)} · 已更新`;
    await refreshMemory();
  } catch (error) {
    memoryState.textContent = error.message || "生成失败";
  } finally {
    button.disabled = false;
  }
}

startButton.addEventListener("click", async () => {
  if (currentPhase === "starting") {
    addLog("正在取消启动");
    render(await window.jarvis.cancelStart());
    return;
  }
  addLog("已提交启动请求");
  try { render(await window.jarvis.start()); } catch (error) { addLog(error.message); }
});

pauseButton.addEventListener("click", async () => {
  try {
    const state = await window.jarvis.getState();
    render(state.monitoring ? await window.jarvis.pause() : await window.jarvis.resume());
  } catch (error) { addLog(error.message); }
});

$("#console-button").addEventListener("click", () => window.jarvis.openConsole());
document.querySelectorAll(".view-tab").forEach(tab => tab.addEventListener("click", () => switchView(tab.dataset.view)));
$("#memory-refresh").addEventListener("click", refreshMemory);
$("#memory-generate").addEventListener("click", () => generateMemory(today));

function renderProfileEditor(settings) {
  gameProfiles = settings.profiles;
  profileSelect.replaceChildren(...gameProfiles.map(profile => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === settings.selectedId;
    return option;
  }));
  const profile = gameProfiles.find(item => item.id === profileSelect.value) || gameProfiles[0];
  profileName.value = profile.name;
  profilePrompt.value = profile.prompt;
  profileDelete.disabled = profile.builtIn;
  profileError.textContent = "";
  refreshIcons();
}

$("#game-profile-button").addEventListener("click", async () => {
  renderProfileEditor(await window.jarvis.getGameProfiles());
  profileDialog.showModal();
});
$("#profile-close").addEventListener("click", () => profileDialog.close());
profileSelect.addEventListener("change", async () => renderProfileEditor(await window.jarvis.selectGameProfile(profileSelect.value)));
$("#profile-add").addEventListener("click", () => {
  const id = `custom-${Date.now()}`;
  gameProfiles.push({ id, name: "新游戏", prompt: "结合当前游戏画面，给出简短、准确、自然的陪伴弹幕。", builtIn: false });
  renderProfileEditor({ selectedId: id, profiles: gameProfiles });
  profileName.select();
});
profileDelete.addEventListener("click", async () => renderProfileEditor(await window.jarvis.deleteGameProfile(profileSelect.value)));
profileForm.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    renderProfileEditor(await window.jarvis.saveGameProfile({ id: profileSelect.value, name: profileName.value, prompt: profilePrompt.value }));
    addLog(`已选用《${profileName.value.trim()}》游戏方案`);
    profileDialog.close();
  } catch (error) { profileError.textContent = error.message; }
});

window.jarvis.onState(render);
window.jarvis.onProgress(addLog);
window.jarvis.onMemoryUpdated(() => {
  if (currentView === "memory") refreshMemory();
  else memoryDot.hidden = false;
});

window.addEventListener("DOMContentLoaded", async () => {
  refreshIcons();
  render(await window.jarvis.getState());
});
