#pragma once

#include "jarvis/capture.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <span>
#include <string>

namespace jarvis {

struct InferenceRequest {
  std::uint64_t id{};
  std::string prompt{};
  std::shared_ptr<const VideoFrame> frame{};
  std::shared_ptr<const std::vector<float>> audio_16khz_mono{};
};

struct InferenceResult {
  std::uint64_t id{};
  std::string text{};
  bool cancelled{};
};

class IOmniRuntime {
 public:
  virtual ~IOmniRuntime() = default;
  virtual void load(std::string model_path) = 0;
  virtual void unload() noexcept = 0;
  [[nodiscard]] virtual bool ready() const noexcept = 0;
  [[nodiscard]] virtual InferenceResult infer(const InferenceRequest& request,
                                               const std::atomic_bool& cancel) = 0;
};

// Link-safe boundary used until the real model runtime adapter is supplied.
[[nodiscard]] std::unique_ptr<IOmniRuntime> make_stub_omni_runtime();

// Production adapter backed by the pinned llama.cpp-omni runtime.
[[nodiscard]] std::unique_ptr<IOmniRuntime> make_real_omni_runtime();

} // namespace jarvis
