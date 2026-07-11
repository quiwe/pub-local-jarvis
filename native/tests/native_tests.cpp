#include "jarvis/audio.hpp"
#include "jarvis/fingerprint.hpp"
#include "jarvis/protocol.hpp"
#include "jarvis/runtime.hpp"
#include "jarvis/scheduler.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <span>
#include <thread>
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
  for (int i = 0; i < 100 && coalescing.busy(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(2));
  coalescing.stop();
  {
    std::lock_guard lock(ordered_mutex);
    require(ordered.size() == 2, "rejected lower-priority work does not add completion");
    require(ordered[0].id == 10 && ordered[0].cancelled, "interactive work cancels active normal work");
    require(ordered[1].id == 11, "accepted interactive request remains pending");
  }
  std::cout << "all native tests passed\n";
}
