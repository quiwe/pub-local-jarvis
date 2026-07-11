#include "jarvis/worker.hpp"

#include "jarvis/audio.hpp"

#include <chrono>
#include <exception>
#include <iostream>
#include <string_view>
#include <thread>
#include <utility>

namespace jarvis {
namespace {
constexpr auto kPerceptionInterval = std::chrono::seconds(5);
constexpr std::string_view kPerceptionPrompt = R"(Continuously analyze the current screen and system audio as AI Jarvis. Return ONLY one compact JSON object with exactly these fields: {"scene":"game|course|other","confidence":0.0,"barrage":"","course_note":"","course_title":"","capture_keyframe":false,"assistant_message":""}.

For a game, first understand the game, HUD, player state, objective, resources, threats, recent outcome, and the meaningful change from recent observations. Do not merely narrate or restate visible objects. The barrage field is REQUIRED and MUST NOT be empty whenever scene is game; course_note, course_title, and assistant_message MUST then be empty. Produce exactly one timely Chinese barrage comment under 30 Chinese characters. Choose the single best mode for the moment: react to a key play, give a genuinely useful tactical hint, make a sharp but playful roast about the operation, act stubborn/tsundere after a close call, or use a restrained counter-jinx. Use the short rhythm, wit, meme-awareness, and conversational energy common in Chinese video danmaku, while writing an original line rather than copying known comments. Be funny, opinionated, and context-specific. Compare the recent barrage fields and do not repeat their main subject, advice, punchline, or sentence pattern. When the scene barely changes, deliberately rotate to a different mode or stay playful about the stalemate instead of paraphrasing the same observation. Roast gameplay decisions, never protected traits or the player's identity; avoid slurs, harassment, sexual content, and invented facts. If the state is uncertain, use a cautious witty reaction instead of pretending to know exact mechanics.

For an online course or lecture, course_note must be concise Chinese key knowledge from the visible slide and audible speech, course_title should identify the subject, and capture_keyframe should be true only when the current screen contains a distinct important slide, diagram, formula, or worked example worth preserving; otherwise use empty strings and false. For other scenes, assistant_message must be a concise Chinese intervention only when there is an important error, risk, deadline, completion, or clearly useful next action; stay silent with an empty string for routine activity. Do not use Markdown and do not add text outside JSON.)";
}
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
      {
        std::lock_guard callback_lock(mutex_);
#ifdef _WIN32
        if (!r.cancelled && r.id >= (std::uint64_t{1} << 63U)) {
          const auto json_start = r.text.find('{');
          if (json_start != std::string::npos &&
              r.text.find("\"scene\"", json_start) != std::string::npos) {
            recent_perceptions_.push_back(r.text.substr(json_start, 1000));
            while (recent_perceptions_.size() > 3) recent_perceptions_.pop_front();
          }
        }
#endif
        callback = completion_;
      }
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
void Worker::submit_prompt(std::uint64_t request_id, std::string prompt) {
  std::lock_guard lock(mutex_);
  if (!scheduler_) return;
  InferenceRequest request{.id=request_id, .prompt=std::move(prompt)};
#ifdef _WIN32
  request.frame = latest_frame_;
  request.audio_16khz_mono = latest_audio_;
#endif
  scheduler_->submit({std::move(request), Priority::interactive});
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
    try {
      desktop_capture->start(); audio_capture->start();
      std::cerr << "Jarvis monitoring capture started" << '\n';
    } catch (const std::exception& error) {
      std::cerr << "Jarvis monitoring capture failed to start: " << error.what() << '\n';
      desktop_capture->stop(); audio_capture->stop(); return;
    } catch (...) {
      std::cerr << "Jarvis monitoring capture failed to start: unknown error" << '\n';
      desktop_capture->stop(); audio_capture->stop(); return;
    }
    auto deadline = std::chrono::steady_clock::now();
    auto next_perception = deadline;
    bool first_frame_logged = false;
    auto last_capture_error = std::chrono::steady_clock::time_point{};
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
          if (!first_frame_logged) {
            std::cerr << "Jarvis monitoring received first desktop frame: "
                      << frame->width << 'x' << frame->height << '\n';
            first_frame_logged = true;
          }
          {
            std::lock_guard lock(mutex_);
            latest_frame_ = frame;
            latest_audio_ = audio_window;
          }
          const auto now = std::chrono::steady_clock::now();
          if (now >= next_perception) {
            std::string prompt(kPerceptionPrompt);
            {
              std::lock_guard lock(mutex_);
              if (!recent_perceptions_.empty()) {
                prompt += "\nRecent structured observations, oldest first (context only; verify against the current frame):";
                for (const auto& observation : recent_perceptions_) {
                  prompt += "\n- ";
                  prompt += observation;
                }
              }
            }
            submit({InferenceRequest{.id=observation_id_.fetch_add(1),
                                     .prompt=std::move(prompt),
                                     .frame=std::move(frame),
                                     .audio_16khz_mono=std::move(audio_window)},
                    Priority::normal});
            next_perception = now + kPerceptionInterval;
          }
        }
      } catch (const std::exception& error) {
        const auto now = std::chrono::steady_clock::now();
        if (now - last_capture_error >= std::chrono::seconds(5)) {
          std::cerr << "Jarvis monitoring capture tick failed: " << error.what() << '\n';
          last_capture_error = now;
        }
      } catch (...) {
        const auto now = std::chrono::steady_clock::now();
        if (now - last_capture_error >= std::chrono::seconds(5)) {
          std::cerr << "Jarvis monitoring capture tick failed: unknown error" << '\n';
          last_capture_error = now;
        }
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
  {
    std::lock_guard lock(mutex_);
    desktop = std::move(desktop_); audio_capture = std::move(audio_);
    latest_frame_.reset(); latest_audio_.reset();
    recent_perceptions_.clear();
  }
  if (audio_capture) audio_capture->stop();
  if (desktop) desktop->stop();
}
#endif
WorkerState Worker::state() const noexcept { return state_.load(); }
void Worker::set_completion(LatestOnlyScheduler::Completion completion) {
  std::lock_guard lock(mutex_); completion_ = std::move(completion);
}
} // namespace jarvis
