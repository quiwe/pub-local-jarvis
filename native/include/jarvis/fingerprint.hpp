#pragma once

#include "jarvis/capture.hpp"

#include <cstdint>

namespace jarvis {

[[nodiscard]] std::uint64_t frame_fingerprint(const VideoFrame& frame) noexcept;

class FrameDeduplicator {
 public:
  [[nodiscard]] bool changed(const VideoFrame& frame) noexcept;
  void reset() noexcept { initialized_ = false; }

 private:
  bool initialized_{};
  std::uint64_t last_{};
};

} // namespace jarvis
