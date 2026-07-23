<div align="center">
  <img src="desktop/assets/icon.png" width="96" alt="AI Jarvis">
  <h1>AI Jarvis（AI 贾维斯）</h1>
  <p>能看懂屏幕、听懂声音的本地全双工桌面助手。</p>
</div>

AI Jarvis 面向 Windows，通过本地多模态模型持续理解桌面画面与系统播放音频，并根据场景以桌宠气泡、游戏弹幕、课程笔记等方式提供帮助。核心感知与推理均在本机完成。

<p align="center">
  <img src="src/jarvis_backend/assets/jarvis-character-reference.png" width="360" alt="AI 贾维斯形象">
</p>

## 主要功能

- **桌面陪伴**：结合实时屏幕画面与系统声音理解当前，在关键时刻给出提醒或点评；桌宠可用鼠标拖拽移动。
- **主动对话**：按 `Ctrl+M` 在桌宠旁打开对话框，可向本地模型输入问题并在同一窗口查看回复。
- **游戏弹幕**：识别实时游戏场景，通过游戏弹幕提供交互，给你游戏主播的体验；系统也支持自定义游戏陪伴方案，例如让它化身嘴臭教练。
- **网课记录**：课程中给出当前课程内容提醒，课后给出带关键画面截图和总结的图文并茂的课程笔记。
- **本地记忆**：AI贾维斯能记住你的所有屏幕活动记录，生成日程总结并保存在本地。
- **日程图**：如果配置了图像生成API，可将日程总结生成为一张日程图。
- **音画屏蔽**：系统支持一键屏蔽功能，屏蔽后模型无法获得屏幕画面和声音。屏蔽功能通过双击桌宠即可开启，关闭屏蔽功能也是通过双击桌宠。

<p align="center">
  <img src="docs/images/pet-chat.png" width="742" alt="AI 贾维斯桌宠主动对话界面">
  <br>
  <sub>按 Ctrl+M 打开桌宠旁的主动对话界面</sub>
</p>

<p align="center">
  <img src="src/jarvis_backend/assets/jarvis-style-reference.png" width="760" alt="AI 贾维斯日程总结图示例">
  <br>
  <sub>日程总结图示例</sub>
</p>

## 全双工模型

项目使用 **MiniCPM-o 4.5** 的 GGUF 模型，由语言模型（LLM）、视觉模型（VPM）和音频模型（APM）共同处理文字、屏幕与声音。模型约每秒接收一帧画面和最近一秒的系统音频，并持续决定：

- `LISTEN`：继续观察，不打扰用户；
- `SPEAK`：输出一句与当前画面或声音有依据的简短文字。

这不是传统的“一问一答”。输入流会持续推进，模型可以延迟到真正需要介入时再响应。项目同时维护两个彼此隔离的模型上下文：

```text
DXGI 屏幕画面 + WASAPI 系统音频
                 |
                 +-- 结构化感知上下文 -> 场景 / 游戏 / 课程 / 记忆
                 |
                 +-- 全双工上下文     -> LISTEN / SPEAK -> 模型回复
```

## 快速开始

### 环境要求

- 64 位 Windows 10/11；
- 至少 12 GiB 可用磁盘空间和可用网络；
- 支持 AVX2 指令集的 x64 处理器；安装包使用兼容性优先的 CPU 推理运行时，速度取决于处理器性能。

### 使用安装包（推荐）

1. 从项目发布页下载 `AI-Jarvis-Setup-<版本>-<架构>.exe`；
2. 运行安装程序并完成安装；
3. 启动 AI Jarvis，点击“启动 AI 贾维斯”。

安装包已经包含 Python 后端和编译好的 C++ 推理运行时，不需要安装 Python、Git、CMake、Visual Studio 或 CUDA。安装包不包含模型权重；首次点击“启动 AI 贾维斯”会自动下载、断点续传并校验约 6.32 GiB 的 MiniCPM-o 4.5 模型，之后可直接启动。模型、记忆和课程工作数据保存在 `%LOCALAPPDATA%\AIJarvis`。

### 从源码启动

源码运行需要 Python 3.12+、Git、CMake 3.24+、Visual Studio 2022 C++ Build Tools、Node.js 当前 LTS 版本与 npm。源码启动器可选用 NVIDIA CUDA，也可以使用 CPU。克隆仓库并进入项目根目录后执行：

```powershell
cd desktop
npm run deps:install
cd ..
.\start-real.cmd
```

打开桌面端后点击“启动 AI 贾维斯”。启动完成后可拖拽桌宠调整位置，按 `Ctrl+M` 打开或关闭桌宠对话框。

### 构建 Windows 安装包

发布构建只在维护者机器上需要 Python 与 C++ 工具链。以下命令会构建静态 MSVC/CPU 原生运行时、冻结 Python 后端，并生成 NSIS 安装程序：

```powershell
cd desktop
npm run deps:install
npm run build
```

产物位于 `desktop/dist/AI-Jarvis-Setup-<版本>-x64.exe`。发布构建不会把源码、编译器或本地运行数据装入安装包。

## 项目组成

- `desktop/`：Electron 桌面端、桌宠、弹幕和托盘。
- `src/jarvis_backend/`：FastAPI 编排、场景策略、课程与记忆。
- `native/`：C++20 屏幕/音频采集、调度与本地推理。

## 致谢与引用

- [tc-mb/llama.cpp-omni](https://github.com/tc-mb/llama.cpp-omni)：提供基于 llama.cpp / ggml 的 MiniCPM-o GGUF 本地推理能力。本项目固定了上游版本，并以关闭语音输出的方式接入 LLM、VPM 与 APM。
- [OpenBMB/MiniCPM-V](https://github.com/OpenBMB/MiniCPM-V/)：MiniCPM-V / MiniCPM-o 官方项目，本项目使用其 MiniCPM-o 4.5 多模态与全双工能力。

更多设计细节见 [项目说明](PROJECT_OVERVIEW.md)。

## 许可证

本项目源代码采用 [MIT License](LICENSE)。

参与开发前请阅读 [贡献指南](CONTRIBUTING.md)，安全问题请按 [安全策略](SECURITY.md) 私下报告。第三方组件及模型许可边界见 [第三方声明](THIRD_PARTY_NOTICES.md)。
