#include "jarvis/fingerprint.hpp"

#include <algorithm>

namespace jarvis {
std::uint64_t frame_fingerprint(const VideoFrame& frame) noexcept {
  // FNV-1a over a fixed 32x18 luminance grid: stable across row padding and inexpensive.
  std::uint64_t hash = 1469598103934665603ULL;
  if (!frame.width || !frame.height || frame.bgra.empty()) return hash;
  for (std::uint32_t gy = 0; gy < 18; ++gy) {
    const auto y = std::min((gy * frame.height) / 18U, frame.height - 1);
    for (std::uint32_t gx = 0; gx < 32; ++gx) {
      const auto x = std::min((gx * frame.width) / 32U, frame.width - 1);
      const auto at = std::size_t(y) * frame.row_pitch + std::size_t(x) * 4U;
      if (at + 2 >= frame.bgra.size()) continue;
      const auto b = std::to_integer<unsigned>(frame.bgra[at]);
      const auto g = std::to_integer<unsigned>(frame.bgra[at + 1]);
      const auto r = std::to_integer<unsigned>(frame.bgra[at + 2]);
      hash ^= std::uint8_t((r * 77U + g * 150U + b * 29U) >> 8U); hash *= 1099511628211ULL;
    }
  }
  hash ^= frame.width; hash *= 1099511628211ULL; hash ^= frame.height;
  return hash;
}
bool FrameDeduplicator::changed(const VideoFrame& frame) noexcept {
  const auto value = frame_fingerprint(frame);
  const bool result = !initialized_ || value != last_; initialized_ = true; last_ = value; return result;
}
} // namespace jarvis
