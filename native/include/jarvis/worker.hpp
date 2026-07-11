#pragma once

#include "jarvis/scheduler.hpp"

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <stop_token>
#include <string>
#include <thread>

namespace jarvis {

enum class WorkerState : std::uint8_t { stopped, starting, running, stopping, faulted };

class Worker {
 public:
  explicit Worker(std::unique_ptr<IOmniRuntime> runtime);
  ~Worker();

  bool start(const std::string& model_path);
  void stop() noexcept;
  void submit(ScheduledRequest request);
  void cancel(std::uint64_t request_id) noexcept;
#ifdef _WIN32
  bool start_monitoring(std::unique_ptr<IDesktopCapture> desktop,
                        std::unique_ptr<IAudioCapture> audio,
                        std::chrono::milliseconds interval = std::chrono::seconds(2));
  void stop_monitoring() noexcept;
#endif
  [[nodiscard]] WorkerState state() const noexcept;
  void set_completion(LatestOnlyScheduler::Completion completion);

 private:
  std::unique_ptr<IOmniRuntime> runtime_;
  std::unique_ptr<LatestOnlyScheduler> scheduler_;
  LatestOnlyScheduler::Completion completion_{};
#ifdef _WIN32
  std::unique_ptr<IDesktopCapture> desktop_{};
  std::unique_ptr<IAudioCapture> audio_{};
  std::jthread capture_thread_{};
  std::atomic_uint64_t observation_id_{1};
#endif
  mutable std::mutex mutex_{};
  std::atomic<WorkerState> state_{WorkerState::stopped};
};

} // namespace jarvis
