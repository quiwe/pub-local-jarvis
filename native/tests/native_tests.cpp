#include "jarvis/audio.hpp"
#include "jarvis/fingerprint.hpp"
#include "jarvis/protocol.hpp"
#include "jarvis/runtime.hpp"
#include "jarvis/scheduler.hpp"
#include "jarvis/worker.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
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
      prompts_[request.id] = request.prompt;
    }
    changed_.notify_all();
    return {request.id, request.prompt, false};
  }
  void wait_request(std::uint64_t id) {
    std::unique_lock lock(mutex_);
    changed_.wait_for(lock, std::chrono::seconds(2), [&] { return contexts_.contains(id); });
  }
  bool had_context(std::uint64_t id) {
    std::lock_guard lock(mutex_); return contexts_.contains(id) && contexts_[id];
  }
  bool received_perception() {
    std::lock_guard lock(mutex_);
    for (const auto& [id, prompt] : prompts_) {
      if (id >= (std::uint64_t{1} << 63U) &&
          prompt.find("course_note") != std::string::npos &&
          prompt.find("\"observation\"") != std::string::npos &&
          prompt.find("普通上网与桌面场景") != std::string::npos &&
          prompt.find("朋友测试") != std::string::npos &&
          prompt.find("纯画面描述") != std::string::npos &&
          prompt.find("画面基本不变") != std::string::npos &&
          prompt.find("JARVIS") != std::string::npos &&
          prompt.find("不得覆盖通用游戏规则") != std::string::npos &&
          prompt.find("<game_profile>关注生存资源</game_profile>") != std::string::npos) {
        return true;
      }
    }
    return false;
  }
 private:
  bool ready_{};
  std::unordered_map<std::uint64_t, bool> contexts_;
  std::unordered_map<std::uint64_t, std::string> prompts_;
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
    return jarvis::audio::PcmBlock{{16'000, 1}, std::vector<float>(320), 0};
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
  require(worker.start("test"), "worker starts with recording runtime");
  worker.set_game_profile("测试游戏", "关注生存资源");
  require(worker.start_monitoring(std::make_unique<TestDesktopCapture>(),
                                  std::make_unique<TestAudioCapture>(),
                                  std::chrono::milliseconds(10)),
          "monitoring starts with capture devices");
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  require(recording_ptr->received_perception(), "monitoring schedules structured perception");
  worker.submit_prompt(21, "describe context");
  recording_ptr->wait_request(21);
  require(recording_ptr->had_context(21), "interactive prompt includes latest capture context");
  worker.stop_monitoring();
  worker.submit_prompt(22, "text only");
  recording_ptr->wait_request(22);
  require(!recording_ptr->had_context(22), "stopping monitoring clears capture context");
  worker.stop();
#endif
  std::cout << "all native tests passed\n";
}
