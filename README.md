# AI Jarvis Backend

Windows 本地优先的 AI 贾维斯应用。核心能力由后端提供，Electron 桌面端只负责启动、系统集成和结果展示：

面向使用者的功能、模型与隐私说明请参阅 [AI 贾维斯项目说明](PROJECT_OVERVIEW.md)。

- **Python/FastAPI 控制面**：状态、场景滞回、弹幕策略、按日文件记忆、课程会话和 UI API。
- **C++20 原生 worker**：DXGI 屏幕捕获、WASAPI 系统回放捕获、2 秒媒体窗口、任务调度和 MiniCPM-o 运行时接口。
- **Electron 桌面端**：一键启动、透明桌宠、聊天气泡、游戏弹幕、托盘和课程关键帧回传。

## 当前完成度

已实现并通过自动测试的部分：

- FastAPI 生命周期、HTTP API、WebSocket 事件流和可选 bearer token。
- Python/C++ 共用的 32 字节小端 IPC 帧：版本、请求 ID、长度、CRC32。
- Windows Named Pipe 客户端/服务端。
- DXGI Desktop Duplication 与 WASAPI loopback 基础采集。
- 16 kHz 单声道重采样、精确 2 秒音频窗口、画面指纹和 latest-only 调度。
- 后台活动记忆、按日 Markdown、本地模型时间轴总结、历史浏览、BM25 风格检索和保留/清理。
- 感知前置画面变化检测；静止、静音 10 分钟后提醒，提醒间隔不少于 15 分钟。
- 课程会话、转写、关键帧、可恢复 Markdown 输出及 Windows Known Folder Desktop 定位。
- 普通场景按需气泡提醒、网课场景低频陪伴气泡、游戏场景桌宠隐藏与点击穿透弹幕层。
- 网课自动开始/结束记录，并导出 `README.md` 和 `images/` 到桌面的独立课程文件夹。
- 独立、固定提交且 SHA-256 验证的第三方运行时源码快照，以及 MiniCPM-o 模型布局校验。

生产 worker 已链接固定版本的 llama.cpp-omni provider。它加载 LLM/VPM/APM 并返回文本；TTS、projector 和 Token2Wav 权重不会加载。`JARVIS_ENABLE_STUB_RUNTIME=ON` 仅用于开发和 native 单元测试，一键真实启动器始终显式关闭该选项。

## Python 开发

要求 Python 3.12+：

```bash
python -m pip install -e ".[test]"
python -m pytest tests/unit -q
python -m ruff check src tests
python -m mypy src
```

启动 fake 控制面：

```bash
jarvis-backend
```

默认监听 `127.0.0.1:8000`。配置位于 `config/default.toml`；如需使用本地配置，应通过 `JARVIS_CONFIG` 指向完整配置文件（当前实现不会自动合并 `config/local.toml`）。

## Windows 一键真实启动

双击 `start-real.cmd`，或在 PowerShell 中运行：

```powershell
.\start-real.ps1
```

启动器只允许 `native.mode = "process"` 和 `JARVIS_ENABLE_STUB_RUNTIME=OFF`。源码门禁通过后，它会检查并安装 Python、CMake、Visual Studio C++ Build Tools 和 CUDA，创建 `.venv`，按固定 revision 下载并校验 MiniCPM-o 的 LLM/VPM/APM GGUF，构建 native worker，再依次启动 worker 与 FastAPI。可选参数包括 `-SkipInstall`、`-SkipModelDownload`、`-CpuOnly` 和 `-Rebuild`。

启动前会验证 `omni_text_runtime` 补丁、真实 `IOmniRuntime` adapter 和 native 链接；任何一项缺失都会在安装或下载前失败，绝不会回退到 fake/stub。

## 桌面应用

首次开发运行：

```powershell
cd desktop
npm install
npm start
```

打开应用后点击“启动 AI 贾维斯”。若 `127.0.0.1:8000` 已有健康后端，桌面端会直接连接；否则会调用 `start-real.ps1 -NoBrowser -SkipSmokeTest` 完成真实环境准备并启动后端。启动成功后控制面板自动收起，应用驻留托盘。

桌面端只消费 `/ws/events` 的后端事件：

- `assistant.message` 仅在有可靠新进展时显示 8 至 30 字的趣味短句，并以“主人”称呼使用者，默认冷却 20 秒；
- `course.interaction` 显示网课陪伴气泡，默认冷却 30 秒；
- `barrage.generated` 在游戏场景显示弹幕；
- `course.keyframe.requested` 触发一次缩放后的屏幕截图并回传课程接口；
- `course.finished` 显示课程总结已生成，并可打开输出位置。

构建 Windows 安装包：

```powershell
cd desktop
npm run build
```

安装包不携带模型权重。首次真实启动仍由后端启动器按既有校验流程准备模型与原生运行时。

主要 API 前缀为 `/api/v1`，包括健康、命令、场景、弹幕、记忆和课程接口。每日记忆通过 `/memory/days` 查询，并通过 `/memory/days/{date}/generate` 调用本地模型归并时间段、生成或刷新。事件 WebSocket 为 `/ws/events`。

设置 `server.bearer_token` 后，HTTP 使用 `Authorization: Bearer <token>`；WebSocket 可使用同一请求头或 `?token=<token>`。

## Native 构建

要求 Visual Studio 2022 C++ 工具链与 CMake 3.24+。

开发 stub 构建：

```bash
cmake -S . -B build -DJARVIS_ENABLE_STUB_RUNTIME=ON
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

生产构建必须设置 `JARVIS_RUNTIME_ENABLE_UPSTREAM=ON`，应用 `VENDOR.json` 中固定 SHA-256 的补丁，并链接 MiniCPM-o provider。

原生 worker 参数：

```text
jarvis-native-worker.exe <pipe-name> <model-root>
```

默认管道为 `\\.\pipe\AIJarvis.Worker.v1`。Python 将 `native.mode` 设为 `process` 后使用 Named Pipe；进程启动/安装器托管仍需在桌面应用层完成。

## 模型目录

模型权重不进入仓库。默认布局：

```text
models/MiniCPM-o-4_5-gguf/
  MiniCPM-o-4_5-Q4_K_M.gguf
  vision/MiniCPM-o-4_5-vision-F16.gguf
  audio/MiniCPM-o-4_5-audio-F16.gguf
```

MVP 是文本输出，不需要 TTS、projector、Token2Wav 或参考音色文件。

## 数据与隐私

- 普通运行不应持久化原始屏幕和音频。
- 记忆事件默认写到 `memory/events.jsonl`，每日文档写到 `memory/daily/YYYY-MM-DD.md`；课程工作文件写到 `courses/sessions/`，这些目录均被 `.gitignore` 排除。
- 课程关键帧只有被课程流程选中时才写盘。
- 网课显示状态需连续 3 次判为非课程才会退出；课程记录会话需持续离课至少 90 秒且达到 4 次感知样本才会结束，APP 重启会继续未完成会话，因此短暂误判不会拆分课程。
- 实时阶段只记录授课语音转写和视觉模型选出的关键画面；课程结束后，后端基于整节课转写统一生成一次最终课程总结。内部转写及截图来源元数据不会写入成品 Markdown。
- 未配置课程输出目录时，最终工件写到 Windows Known Folder Desktop 下的 `Jarvis-Courses/<session-id>/`，其中包含 `README.md` 和 `images/`。
- 暂停监控会停止采集线程并清空 worker 持有的采集对象。

## 第三方和模型许可

第三方运行时来源、固定提交与归档 SHA-256 位于 `third_party/runtime/VENDOR.json`；MIT notice 位于同目录。这里记录的是**源代码许可**，不代表 MiniCPM-o 模型权重许可。分发 GGUF 权重前必须独立确认模型卡、商业使用和再分发条款。当前安装包不得携带权重或静默下载权重。

## 已知验证边界

本开发环境没有 CMake、MSVC、GCC 或 Clang，因此本轮无法实际编译 Windows C++ worker，也无法执行 DXGI/WASAPI 真实采集或 CUDA/MiniCPM-o GPU 验证。Python 的单元测试、Ruff 和 mypy 已通过。完整发布前仍必须在 NVIDIA Windows 机器上完成：

1. native 编译与 CTest；
2. 30 分钟屏幕/音频 soak；
3. 设备切换、锁屏、显示器重配恢复；
4. 真实 LLM/VPM/APM provider、KV 滑窗和 500 个切片稳定性；
5. 课程录屏到桌面 Markdown/关键帧的产品级 E2E；
6. 删除 `others/` 后的干净构建验证。
