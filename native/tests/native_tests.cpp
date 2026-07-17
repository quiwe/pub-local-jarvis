#include "jarvis/audio.hpp"
#include "jarvis/fingerprint.hpp"
#include "jarvis/protocol.hpp"
#include "jarvis/runtime.hpp"
#include "jarvis/scheduler.hpp"
#include "jarvis/worker.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <span>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {
void require(bool value, const char* message) { if (!value) { std::cerr << "FAIL: " << message << '\n'; std::exit(1); } }
std::span<const std::byte> bytes(const char* value, std::size_t size) {
  return {reinterpret_cast<const std::byte*>(value), size};
}
class BlockingRuntime final : public jarvis::IOmniRuntime {
 public:
  void load(std::string) override { ready_ = true; }
  void unload() noexcept override { ready_ = false; }
  bool ready() const noexcept override { return ready_; }
  jarvis::InferenceResult infer(const jarvis::InferenceRequest& request,
                                const std::atomic_bool& cancel) override {
    {
      std::lock_guard lock(mutex_); active_ = true;
    }
    changed_.notify_all();
    std::unique_lock lock(mutex_);
    changed_.wait(lock, [&] { return released_ || cancel.load(); });
    return {request.id, request.prompt, cancel.load()};
  }
  void wait_active() { std::unique_lock lock(mutex_); changed_.wait(lock, [&] { return active_; }); }
  void release() { { std::lock_guard lock(mutex_); released_ = true; } changed_.notify_all(); }
 private:
  bool ready_{true}; bool active_{}; bool released_{}; std::mutex mutex_; std::condition_variable changed_;
};
#ifdef _WIN32
class RecordingRuntime final : public jarvis::IOmniRuntime {
 public:
  void load(std::string) override { ready_ = true; }
  void unload() noexcept override { ready_ = false; }
  bool ready() const noexcept override { return ready_; }
  jarvis::InferenceResult infer(const jarvis::InferenceRequest& request,
                                const std::atomic_bool&) override {
    {
      std::lock_guard lock(mutex_);
      contexts_[request.id] = bool(request.frame) && bool(request.audio_16khz_mono);
      audible_contexts_[request.id] =
          request.audio_16khz_mono &&
          std::ranges::any_of(*request.audio_16khz_mono,
                              [](float sample) { return sample != 0.0F; });
      prompts_[request.id] = request.prompt;
    }
    changed_.notify_all();
    if (request.prompt.find("场景分类与客观信息提取器") != std::string::npos &&
        request.prompt.find("不得生成游戏弹幕") != std::string::npos) {
      return {request.id,
              R"({"scene":"game","confidence":0.9,"scene_evidence":{"interactive_gameplay":true,"game_video_or_stream":false},"observation":"玩家正在进行测试游戏"})",
              false};
    }
    return {request.id,
            R"({"scene":"game","confidence":0.9,"scene_evidence":{"interactive_gameplay":true,"game_video_or_stream":false},"observation":"玩家正在进行测试游戏","barrage_candidates":["测试弹幕"]})",
            false};
  }
  bool start_duplex(std::string instruction) override {
    std::lock_guard lock(mutex_);
    duplex_instruction_ = std::move(instruction);
    duplex_active_ = true;
    return true;
  }
  void stop_duplex() noexcept override {
    {
      std::lock_guard lock(mutex_);
      duplex_active_ = false;
    }
    changed_.notify_all();
  }
  bool duplex_active() const noexcept override { return duplex_active_.load(); }
  bool push_duplex(jarvis::DuplexFrame frame) override {
    std::lock_guard lock(mutex_);
    if (!duplex_active_) return false;
    duplex_had_context_ = bool(frame.frame) && bool(frame.audio_16khz_mono) &&
                          frame.audio_16khz_mono->size() == 16'000;
    duplex_results_.push_back({frame.sequence, true, frame.sequence == 2,
                               frame.sequence == 2 ? "测试条件已满足" : "", 5.0});
    changed_.notify_all();
    return true;
  }
  std::optional<jarvis::DuplexResult> wait_duplex(
      std::chrono::milliseconds timeout) override {
    std::unique_lock lock(mutex_);
    changed_.wait_for(lock, timeout, [&] {
      return !duplex_results_.empty() || !duplex_active_;
    });
    if (duplex_results_.empty()) return std::nullopt;
    auto result = std::move(duplex_results_.front());
    duplex_results_.pop_front();
    return result;
  }
  void wait_request(std::uint64_t id) {
    std::unique_lock lock(mutex_);
    changed_.wait_for(lock, std::chrono::seconds(2), [&] { return contexts_.contains(id); });
  }
  bool had_context(std::uint64_t id) {
    std::lock_guard lock(mutex_); return contexts_.contains(id) && contexts_[id];
  }
  bool received_audible_perception() {
    std::lock_guard lock(mutex_);
    return std::ranges::any_of(audible_contexts_, [](const auto& item) {
      return item.first >= (std::uint64_t{1} << 63U) && item.second;
    });
  }
  bool received_perception() {
    std::lock_guard lock(mutex_);
    bool clean_classification = false;
    bool profiled_game_generation = false;
    for (const auto& [id, prompt] : prompts_) {
      if (id < (std::uint64_t{1} << 63U)) continue;
      if (prompt.find("不得生成游戏弹幕") != std::string::npos &&
          prompt.find("场景判定") != std::string::npos &&
          prompt.find("scene_evidence") != std::string::npos &&
          prompt.find("course_interaction") != std::string::npos &&
          prompt.find("游戏视频、直播、回放") != std::string::npos &&
          prompt.find("搜索结果、与音频无关的普通网页") != std::string::npos &&
          prompt.find("老师或讲师不需要出现在画面中") != std::string::npos &&
          prompt.find("静态 PPT 或笔记") != std::string::npos &&
          prompt.find("结合两种模态交叉验证") != std::string::npos &&
          prompt.find("普通主动文本完全由独立的原生全双工会话决定") !=
              std::string::npos &&
          prompt.find("assistant_candidates") == std::string::npos &&
          prompt.find("<game_profile>") == std::string::npos &&
          prompt.find("关注生存资源") == std::string::npos) {
        clean_classification = true;
      }
      if (prompt.find("已经确认当前是 game") != std::string::npos &&
          prompt.find("你不会再次收到截图或音频") != std::string::npos &&
          prompt.find("scene_evidence") != std::string::npos &&
          prompt.find("必须生成恰好 3 条") != std::string::npos &&
          prompt.find("冷却、去重和是否展示由后端负责") != std::string::npos &&
          prompt.find("本轮游戏弹幕主角度") != std::string::npos &&
          prompt.find("<game_profile>关注生存资源</game_profile>") != std::string::npos) {
        profiled_game_generation = true;
      }
    }
    return clean_classification && profiled_game_generation;
  }
  bool game_generation_is_text_only() {
    std::lock_guard lock(mutex_);
    for (const auto& [id, prompt] : prompts_) {
      if (id >= (std::uint64_t{1} << 63U) &&
          prompt.find("已经确认当前是 game") != std::string::npos &&
          contexts_.contains(id) && !contexts_[id]) return true;
    }
    return false;
  }
  std::size_t perception_request_count() {
    std::lock_guard lock(mutex_);
    return std::count_if(prompts_.begin(), prompts_.end(), [](const auto& item) {
      return item.first >= (std::uint64_t{1} << 63U);
    });
  }
  bool received_duplex_context() {
    std::lock_guard lock(mutex_);
    return duplex_had_context_ && duplex_instruction_.find("绿灯") != std::string::npos;
  }
 private:
  bool ready_{};
  std::unordered_map<std::uint64_t, bool> contexts_;
  std::unordered_map<std::uint64_t, bool> audible_contexts_;
  std::unordered_map<std::uint64_t, std::string> prompts_;
  std::deque<jarvis::DuplexResult> duplex_results_;
  std::string duplex_instruction_;
  std::atomic_bool duplex_active_{false};
  bool duplex_had_context_{};
  std::mutex mutex_; std::condition_variable changed_;
};
class TestDesktopCapture final : public jarvis::IDesktopCapture {
 public:
  void start() override {}
  void stop() noexcept override {}
  std::optional<jarvis::VideoFrame> next_frame(std::uint32_t) override {
    return jarvis::VideoFrame{2, 2, 8, 0, std::vector<std::byte>(16)};
  }
};
class TestAudioCapture final : public jarvis::IAudioCapture {
 public:
  void start() override {}
  void stop() noexcept override {}
  std::optional<jarvis::audio::PcmBlock> next_block(std::uint32_t) override {
    return jarvis::audio::PcmBlock{{16'000, 1}, std::vector<float>(320, 0.01F), 0};
  }
};
#endif
}
int main() {
  using namespace jarvis;
  const char text[] = "hello";
  auto encoded = ipc::encode(ipc::MessageType::submit, 42, bytes(text, 5));
  auto decoded = ipc::decode(encoded);
  require(bool(decoded), "protocol round trip");
  require(decoded.message.header.request_id == 42 && decoded.message.payload.size() == 5, "protocol fields");
  encoded.back() ^= std::byte{1}; require(!ipc::decode(encoded), "protocol detects corruption");

  const float stereo[] = {1, -1, .5F, .5F};
  auto mono = audio::downmix_mono(stereo, 2);
  require(mono.size() == 2 && mono[0] == 0 && mono[1] == .5F, "PCM downmix");
  auto up = audio::resample_linear(mono, 2, 4); require(up.size() == 4, "PCM resampling size");
  audio::ExactWindowAssembler windows(10, 2'000);
  float samples[45]{}; auto first = windows.push(std::span(samples, 15)); require(first.empty(), "partial window held");
  auto second = windows.push(std::span(samples + 15, 30)); require(second.size() == 2 && second[0].size() == 20, "exact windows");

  VideoFrame frame{2, 2, 8, 0, std::vector<std::byte>(16)};
  FrameDeduplicator dedupe; require(dedupe.changed(frame), "first frame changes"); require(!dedupe.changed(frame), "duplicate frame ignored");
  frame.bgra[0] = std::byte{255}; require(dedupe.changed(frame), "changed frame detected");
  VideoFrame large_frame{64, 36, 256, 0, std::vector<std::byte>(64 * 36 * 4)};
  FrameChangeDetector visual_changes;
  require(visual_changes.changed(large_frame), "first visual sample changes");
  large_frame.bgra[0] = std::byte{255};
  require(!visual_changes.changed(large_frame), "localized pixel noise is ignored");
  for (std::size_t sample = 1; sample <= 4; ++sample) {
    const auto at = sample * 2 * 4;
    large_frame.bgra[at] = std::byte{255};
    large_frame.bgra[at + 1] = std::byte{255};
    large_frame.bgra[at + 2] = std::byte{255};
  }
  require(!visual_changes.changed(large_frame), "small changes accumulate below threshold");
  for (std::size_t sample = 5; sample <= 8; ++sample) {
    const auto at = sample * 2 * 4;
    large_frame.bgra[at] = std::byte{255};
    large_frame.bgra[at + 1] = std::byte{255};
    large_frame.bgra[at + 2] = std::byte{255};
  }
  require(visual_changes.changed(large_frame), "accumulated visual change is detected");
  for (std::size_t index = 0; index < large_frame.bgra.size() / 2; index += 4) {
    large_frame.bgra[index] = std::byte{255};
    large_frame.bgra[index + 1] = std::byte{255};
    large_frame.bgra[index + 2] = std::byte{255};
  }
  require(visual_changes.changed(large_frame), "broad visual change is detected");

  auto runtime = make_stub_omni_runtime(); runtime->load("stub");
  std::mutex mutex; std::vector<InferenceResult> results;
  LatestOnlyScheduler scheduler(*runtime, [&](InferenceResult r) { std::lock_guard lock(mutex); results.push_back(std::move(r)); });
  scheduler.start(); scheduler.submit({InferenceRequest{.id=7, .prompt="test"}, Priority::interactive});
  for (int i = 0; i < 100 && scheduler.busy(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(2));
  scheduler.stop();
  { std::lock_guard lock(mutex); require(!results.empty() && results.back().id == 7, "scheduler invokes runtime"); }

  BlockingRuntime blocking; std::vector<InferenceResult> ordered; std::mutex ordered_mutex;
  LatestOnlyScheduler coalescing(blocking, [&](InferenceResult r) {
    std::lock_guard lock(ordered_mutex); ordered.push_back(std::move(r));
  });
  coalescing.start();
  coalescing.submit({InferenceRequest{.id=10, .prompt="active"}, Priority::normal});
  blocking.wait_active();
  coalescing.submit({InferenceRequest{.id=11, .prompt="interactive"}, Priority::interactive});
  coalescing.submit({InferenceRequest{.id=12, .prompt="rejected background"}, Priority::background});
  blocking.release();
  for (int i = 0; i < 100; ++i) {
    {
      std::lock_guard lock(ordered_mutex);
      if (ordered.size() == 1 && ordered.front().id == 11) break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  coalescing.stop();
  {
    std::lock_guard lock(ordered_mutex);
    require(ordered.size() == 1, "cancelled stale and rejected work do not add completion");
    require(ordered[0].id == 11, "accepted interactive request remains pending");
  }
#ifdef _WIN32
  auto recording = std::make_unique<RecordingRuntime>();
  auto* recording_ptr = recording.get();
  Worker worker(std::move(recording));
  std::mutex native_event_mutex;
  std::vector<std::string> native_events;
  worker.set_completion([&](InferenceResult result) {
    if (result.id != std::numeric_limits<std::uint64_t>::max()) return;
    std::lock_guard lock(native_event_mutex);
    native_events.push_back(std::move(result.text));
  });
  require(worker.start("test"), "worker starts with recording runtime");
  worker.set_game_profile("测试游戏", "关注生存资源");
  require(worker.start_monitoring(std::make_unique<TestDesktopCapture>(),
                                  std::make_unique<TestAudioCapture>(),
                                  std::chrono::milliseconds(10)),
          "monitoring starts with capture devices");
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  require(recording_ptr->received_perception(), "monitoring schedules structured perception");
  require(recording_ptr->received_audible_perception(),
          "structured perception receives audible system audio");
  require(recording_ptr->perception_request_count() == 2,
          "unchanged frames do not schedule repeated perception");
  require(recording_ptr->game_generation_is_text_only(),
          "game generation does not resend classification media");
  require(worker.start_duplex("traffic-light", "持续观察画面，绿灯亮起时提醒我"),
          "duplex task starts while monitoring remains active");
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  require(recording_ptr->received_duplex_context(),
          "duplex task receives one-second audio and current frame");
  {
    std::lock_guard lock(native_event_mutex);
    require(std::ranges::any_of(native_events, [](const auto& event) {
              return event.find("\"decision\":\"listen\"") != std::string::npos;
            }),
            "duplex task emits model listen decisions");
    require(std::ranges::any_of(native_events, [](const auto& event) {
              return event.find("\"decision\":\"speak\"") != std::string::npos &&
                     event.find("测试条件已满足") != std::string::npos;
            }),
            "duplex task emits model speak decisions with text");
  }
  require(recording_ptr->perception_request_count() == 2,
          "duplex task does not replace structured perception");
  worker.stop_duplex();
  worker.submit_prompt(21, "describe context");
  recording_ptr->wait_request(21);
  require(recording_ptr->had_context(21), "interactive prompt includes latest capture context");
  worker.submit_prompt(23, "[[JARVIS_TEXT_ONLY]]\nsummarize transcript");
  recording_ptr->wait_request(23);
  require(!recording_ptr->had_context(23), "text-only prompt excludes capture context");
  worker.stop_monitoring();
  worker.submit_prompt(22, "text only");
  recording_ptr->wait_request(22);
  require(!recording_ptr->had_context(22), "stopping monitoring clears capture context");
  worker.stop();
#endif
  std::cout << "all native tests passed\n";
}
