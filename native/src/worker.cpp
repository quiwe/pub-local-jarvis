#include "jarvis/worker.hpp"

#include "jarvis/audio.hpp"

#include <chrono>
#include <exception>
#include <thread>
#include <utility>

namespace jarvis {
Worker::Worker(std::unique_ptr<IOmniRuntime> runtime) : runtime_(std::move(runtime)) {}
Worker::~Worker() { stop(); }
bool Worker::start(const std::string& model_path) {
  std::lock_guard lock(mutex_);
  if (state_ == WorkerState::running) return true;
  state_ = WorkerState::starting;
  try {
    runtime_->load(model_path);
    scheduler_ = std::make_unique<LatestOnlyScheduler>(*runtime_, [this](InferenceResult r) {
      LatestOnlyScheduler::Completion callback;
      { std::lock_guard callback_lock(mutex_); callback = completion_; }
      if (callback) callback(std::move(r));
    });
    scheduler_->start(); state_ = WorkerState::running; return true;
  } catch (...) { state_ = WorkerState::faulted; return false; }
}
void Worker::stop() noexcept {
#ifdef _WIN32
  stop_monitoring();
#endif
  std::unique_ptr<LatestOnlyScheduler> scheduler;
  {
    std::lock_guard lock(mutex_);
    if (state_ == WorkerState::stopped) return;
    state_ = WorkerState::stopping; scheduler = std::move(scheduler_);
  }
  if (scheduler) scheduler->stop(); runtime_->unload(); state_ = WorkerState::stopped;
}
void Worker::submit(ScheduledRequest request) {
  std::lock_guard lock(mutex_); if (scheduler_) scheduler_->submit(std::move(request));
}
void Worker::cancel(std::uint64_t id) noexcept { std::lock_guard lock(mutex_); if (scheduler_) scheduler_->cancel(id); }
#ifdef _WIN32
bool Worker::start_monitoring(std::unique_ptr<IDesktopCapture> desktop,
                              std::unique_ptr<IAudioCapture> audio_capture,
                              std::chrono::milliseconds interval) {
  if (!desktop || !audio_capture || interval.count() <= 0 || state_ != WorkerState::running) return false;
  stop_monitoring();
  {
    std::lock_guard lock(mutex_);
    desktop_ = std::move(desktop); audio_ = std::move(audio_capture);
  }
  capture_thread_ = std::jthread([this, interval](std::stop_token stop) {
    std::unique_lock initial_lock(mutex_);
    auto* desktop_capture = desktop_.get(); auto* audio_capture = audio_.get();
    initial_lock.unlock();
    try { desktop_capture->start(); audio_capture->start(); }
    catch (...) { desktop_capture->stop(); audio_capture->stop(); return; }
    auto deadline = std::chrono::steady_clock::now();
    std::vector<float> accumulated;
    while (!stop.stop_requested()) {
      deadline += interval;
      std::shared_ptr<VideoFrame> frame;
      try {
        std::unique_lock lock(mutex_);
        auto* desktop_capture = desktop_.get(); auto* audio_capture = audio_.get();
        lock.unlock();
        while (std::chrono::steady_clock::now() < deadline && !stop.stop_requested()) {
          if (auto block = audio_capture->next_block(20)) {
            auto mono = audio::downmix_mono(block->interleaved, block->format.channels);
            auto samples = audio::resample_linear(mono, block->format.sample_rate, 16'000);
            accumulated.insert(accumulated.end(), samples.begin(), samples.end());
          }
          if (auto captured = desktop_capture->next_frame(0)) frame = std::make_shared<VideoFrame>(std::move(*captured));
        }
        constexpr std::size_t required = 32'000;
        if (accumulated.size() < required) accumulated.insert(accumulated.begin(), required - accumulated.size(), 0.0F);
        if (accumulated.size() > required) accumulated.erase(accumulated.begin(), accumulated.end() - required);
        auto audio_window = std::make_shared<std::vector<float>>(std::move(accumulated)); accumulated.clear();
        if (frame) {
          submit({InferenceRequest{.id=observation_id_.fetch_add(1), .prompt="Observe the current screen and audio.",
                                   .frame=std::move(frame), .audio_16khz_mono=std::move(audio_window)},
                  Priority::normal});
        }
      } catch (...) {
        // A device invalidation drops this tick. The next tick retries through the capture implementation.
      }
      std::this_thread::sleep_until(deadline);
    }
    audio_capture->stop(); desktop_capture->stop();
  });
  return true;
}
void Worker::stop_monitoring() noexcept {
  if (capture_thread_.joinable()) { capture_thread_.request_stop(); capture_thread_.join(); }
  std::unique_ptr<IDesktopCapture> desktop; std::unique_ptr<IAudioCapture> audio_capture;
  { std::lock_guard lock(mutex_); desktop = std::move(desktop_); audio_capture = std::move(audio_); }
  if (audio_capture) audio_capture->stop();
  if (desktop) desktop->stop();
}
#endif
WorkerState Worker::state() const noexcept { return state_.load(); }
void Worker::set_completion(LatestOnlyScheduler::Completion completion) {
  std::lock_guard lock(mutex_); completion_ = std::move(completion);
}
} // namespace jarvis
