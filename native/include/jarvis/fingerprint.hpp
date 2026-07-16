#pragma once

#include "jarvis/capture.hpp"

#include <cstdint>
#include <vector>

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

class FrameChangeDetector {
 public:
  explicit FrameChangeDetector(std::uint8_t pixel_threshold = 18,
                               float changed_ratio_threshold = 0.03F,
                               float average_delta_threshold = 3.0F)
      : pixel_threshold_(pixel_threshold),
        changed_ratio_threshold_(changed_ratio_threshold),
        average_delta_threshold_(average_delta_threshold) {}

  [[nodiscard]] bool changed(const VideoFrame& frame) noexcept;
  void reset() noexcept { previous_.clear(); }

 private:
  std::uint8_t pixel_threshold_;
  float changed_ratio_threshold_;
  float average_delta_threshold_;
  std::vector<std::uint8_t> previous_{};
};

} // namespace jarvis
