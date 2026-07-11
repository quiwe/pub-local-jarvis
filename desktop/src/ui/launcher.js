"use strict";

const startButton = document.querySelector("#start-button");
const pauseButton = document.querySelector("#pause-button");
const consoleButton = document.querySelector("#console-button");
const phaseChip = document.querySelector("#phase-chip");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const monitorValue = document.querySelector("#monitor-value");
const sceneValue = document.querySelector("#scene-value");
const activityLog = document.querySelector("#activity-log");
let currentPhase = "idle";

const sceneNames = { game: "游戏", course: "网课", other: "其他" };
const phaseView = {
  idle: ["待启动", "系统处于待命状态", "启动后将连接本地模型并持续理解屏幕与系统声音。"],
  starting: ["启动中", "正在启动本地 AI", "首次运行可能需要安装依赖和下载模型，请保持网络连接。"],
  running: ["运行中", "持续感知已开启", "AI 贾维斯正在本机理解当前画面，并只在必要时介入。"],
  paused: ["已暂停", "环境感知已暂停", "屏幕和系统音频当前不会被采集。"],
  error: ["异常", "启动未完成", "请查看下方日志后重试。"],
};

function now() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function addLog(message) {
  const lines = String(message).split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(-3)) {
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
  sceneValue.textContent = sceneNames[state.scene] || "其他";
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
  if (window.lucide) window.lucide.createIcons();
}

startButton.addEventListener("click", async () => {
  if (currentPhase === "starting") {
    addLog("正在取消启动");
    render(await window.jarvis.cancelStart());
    return;
  }
  addLog("已提交一键启动请求");
  try {
    render(await window.jarvis.start());
  } catch (error) {
    addLog(error.message);
  }
});

pauseButton.addEventListener("click", async () => {
  try {
    const current = await window.jarvis.getState();
    render(current.monitoring ? await window.jarvis.pause() : await window.jarvis.resume());
  } catch (error) {
    addLog(error.message);
  }
});

consoleButton.addEventListener("click", () => window.jarvis.openConsole());
window.jarvis.onState(render);
window.jarvis.onProgress(addLog);

window.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) window.lucide.createIcons();
  render(await window.jarvis.getState());
});
