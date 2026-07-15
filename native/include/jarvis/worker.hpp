#pragma once

#include "jarvis/scheduler.hpp"

#include <atomic>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>
#include <stop_token>
#include <string>
#include <thread>
#include <vector>

namespace jarvis {

enum class WorkerState : std::uint8_t { stopped, starting, running, stopping, faulted };

class Worker {
 public:
  explicit Worker(std::unique_ptr<IOmniRuntime> runtime);
  ~Worker();

  bool start(const std::string& model_path);
  void stop() noexcept;
  void submit(ScheduledRequest request);
  void submit_prompt(std::uint64_t request_id, std::string prompt);
  void cancel(std::uint64_t request_id) noexcept;
  void set_game_profile(std::string name, std::string prompt);
#ifdef _WIN32
  bool start_monitoring(std::unique_ptr<IDesktopCapture> desktop,
                        std::unique_ptr<IAudioCapture> audio,
                        std::chrono::milliseconds interval = std::chrono::seconds(1));
  void stop_monitoring() noexcept;
#endif
  [[nodiscard]] WorkerState state() const noexcept;
  void set_completion(LatestOnlyScheduler::Completion completion);

 private:
  std::unique_ptr<IOmniRuntime> runtime_;
  std::unique_ptr<LatestOnlyScheduler> scheduler_;
  LatestOnlyScheduler::Completion completion_{};
#ifdef _WIN32
  struct RecentPerception {
    std::string scene;
    std::string observation;
    std::string course_transcript;
    std::vector<std::string> barrages;
  };
  std::unique_ptr<IDesktopCapture> desktop_{};
  std::unique_ptr<IAudioCapture> audio_{};
  std::jthread capture_thread_{};
  std::shared_ptr<const VideoFrame> latest_frame_{};
  std::shared_ptr<const std::vector<float>> latest_audio_{};
  std::uint64_t active_perception_id_{};
  bool active_perception_is_classification_{};
  std::shared_ptr<const VideoFrame> active_perception_frame_{};
  std::shared_ptr<const std::vector<float>> active_perception_audio_{};
  std::uintptr_t latest_foreground_window_{};
  std::uintptr_t active_perception_window_{};
  std::atomic_bool reset_perception_audio_{false};
  std::deque<RecentPerception> recent_perceptions_{};
  std::string game_profile_name_{};
  std::string game_profile_prompt_{};
  std::size_t game_barrage_angle_index_{};
  std::atomic_uint64_t observation_id_{std::uint64_t{1} << 63U};
#endif
  mutable std::mutex mutex_{};
  std::atomic<WorkerState> state_{WorkerState::stopped};
};

} // namespace jarvis
