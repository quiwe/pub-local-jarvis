#include "jarvis/runtime.hpp"

#include "jarvis/runtime/model_layout.hpp"

#include "common.h"
#include "omni.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace jarvis {
namespace {

namespace fs = std::filesystem;

std::string path_string(const fs::path& path) {
  return path.string();
}

void write_u16(std::ostream& stream, std::uint16_t value) {
  const std::array<char, 2> bytes{
      static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU)};
  stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_u32(std::ostream& stream, std::uint32_t value) {
  const std::array<char, 4> bytes{
      static_cast<char>(value & 0xffU), static_cast<char>((value >> 8U) & 0xffU),
      static_cast<char>((value >> 16U) & 0xffU), static_cast<char>((value >> 24U) & 0xffU)};
  stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void write_i32(std::ostream& stream, std::int32_t value) {
  write_u32(stream, static_cast<std::uint32_t>(value));
}

class TemporaryMedia {
 public:
  TemporaryMedia() = default;
  TemporaryMedia(const TemporaryMedia&) = delete;
  TemporaryMedia& operator=(const TemporaryMedia&) = delete;
  TemporaryMedia(TemporaryMedia&& other) noexcept : paths_(std::move(other.paths_)) {
    other.paths_.clear();
  }
  TemporaryMedia& operator=(TemporaryMedia&&) = delete;
  ~TemporaryMedia() {
    for (const auto& path : paths_) {
      std::error_code error;
      fs::remove(path, error);
    }
  }

  fs::path add(std::string_view stem, std::uint64_t request_id, std::string_view extension) {
    auto root = fs::temp_directory_path() / "AIJarvis";
    fs::create_directories(root);
    auto path = root / (std::string(stem) + "-" + std::to_string(request_id) +
                        std::string(extension));
    paths_.push_back(path);
    return path;
  }

 private:
  std::vector<fs::path> paths_;
};

void write_bgra_bmp(const fs::path& path, const VideoFrame& frame) {
  if (frame.width == 0 || frame.height == 0 ||
      frame.row_pitch < static_cast<std::uint64_t>(frame.width) * 4U) {
    throw std::runtime_error("captured video frame has invalid dimensions");
  }
  const auto source_bytes = static_cast<std::uint64_t>(frame.row_pitch) * frame.height;
  if (frame.bgra.size() < source_bytes) {
    throw std::runtime_error("captured video frame is truncated");
  }

  const std::uint32_t row_bytes = frame.width * 4U;
  const std::uint32_t pixel_bytes = row_bytes * frame.height;
  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  if (!stream) throw std::runtime_error("unable to create temporary BMP");

  write_u16(stream, 0x4d42U);
  write_u32(stream, 14U + 40U + pixel_bytes);
  write_u16(stream, 0U);
  write_u16(stream, 0U);
  write_u32(stream, 54U);
  write_u32(stream, 40U);
  write_i32(stream, static_cast<std::int32_t>(frame.width));
  write_i32(stream, -static_cast<std::int32_t>(frame.height));
  write_u16(stream, 1U);
  write_u16(stream, 32U);
  write_u32(stream, 0U);
  write_u32(stream, pixel_bytes);
  write_i32(stream, 2835);
  write_i32(stream, 2835);
  write_u32(stream, 0U);
  write_u32(stream, 0U);

  for (std::uint32_t row = 0; row < frame.height; ++row) {
    const auto offset = static_cast<std::size_t>(row) * frame.row_pitch;
    stream.write(reinterpret_cast<const char*>(frame.bgra.data() + offset), row_bytes);
  }
  if (!stream) throw std::runtime_error("failed to write temporary BMP");
}

void write_float_wav(const fs::path& path, const std::vector<float>& samples) {
  if (samples.empty()) throw std::runtime_error("captured audio window is empty");
  constexpr std::uint32_t sample_rate = 16'000U;
  constexpr std::uint16_t channels = 1U;
  constexpr std::uint16_t bits_per_sample = 32U;
  constexpr std::uint16_t block_align = channels * bits_per_sample / 8U;
  constexpr std::uint32_t byte_rate = sample_rate * block_align;
  const auto data_bytes_64 = samples.size() * sizeof(float);
  if (data_bytes_64 > std::numeric_limits<std::uint32_t>::max()) {
    throw std::runtime_error("captured audio window is too large");
  }
  const auto data_bytes = static_cast<std::uint32_t>(data_bytes_64);

  std::ofstream stream(path, std::ios::binary | std::ios::trunc);
  if (!stream) throw std::runtime_error("unable to create temporary WAV");
  stream.write("RIFF", 4);
  write_u32(stream, 36U + data_bytes);
  stream.write("WAVE", 4);
  stream.write("fmt ", 4);
  write_u32(stream, 16U);
  write_u16(stream, 3U);  // WAVE_FORMAT_IEEE_FLOAT
  write_u16(stream, channels);
  write_u32(stream, sample_rate);
  write_u32(stream, byte_rate);
  write_u16(stream, block_align);
  write_u16(stream, bits_per_sample);
  stream.write("data", 4);
  write_u32(stream, data_bytes);
  stream.write(reinterpret_cast<const char*>(samples.data()), data_bytes);
  if (!stream) throw std::runtime_error("failed to write temporary WAV");
}

std::string validation_error(const runtime::ValidationResult& validation) {
  std::ostringstream message;
  message << "invalid MiniCPM-o model layout";
  for (const auto& error : validation.errors) message << "\n  - " << error;
  return message.str();
}

class RealOmniRuntime final : public IOmniRuntime {
 public:
  ~RealOmniRuntime() override { unload(); }

  void load(std::string model_path) override {
    unload();
    round_ = 0;
    const fs::path root(model_path);
    const auto validation = runtime::validate_minicpm_o_4_5_layout(root);
    if (!validation.ok()) throw std::runtime_error(validation_error(validation));

    static std::once_flag common_initialized;
    std::call_once(common_initialized, [] { common_init(); });

    params_ = common_params{};
    params_.model.path = path_string(validation.files.llm.path);
    params_.vpm_model = path_string(validation.files.vpm.path);
    params_.apm_model = path_string(validation.files.apm.path);
    params_.n_ctx = 4096;
    params_.n_batch = 512;
    params_.n_ubatch = 256;
    params_.n_predict = 256;
    params_.n_gpu_layers = 99;
    params_.cpuparams.n_threads = std::max(1, common_cpu_get_num_physical_cores());
    params_.cpuparams_batch.n_threads = params_.cpuparams.n_threads;
    params_.display_prompt = false;
    params_.show_timings = false;

    context_ = omni_init(&params_, 2, false, "", -1, "gpu:0", false);
    if (context_ == nullptr) throw std::runtime_error("omni_init failed");

    // Jarvis already runs inference on LatestOnlyScheduler's worker thread.
    // Keep upstream simplex execution synchronous to avoid its internal LLM
    // thread racing stream_decode when TTS is disabled.
    context_->async = false;
    context_->omni_voice_clone_prompt =
        "<|im_start|>system\nYou are AI Jarvis, a helpful local assistant.\n";
    context_->omni_assistant_prompt = "<|im_end|>\n<|im_start|>user\n";
    if (!stream_prefill(context_, "", "", 0, -1, "")) {
      omni_free(context_);
      context_ = nullptr;
      throw std::runtime_error("failed to initialize the MiniCPM-o system prompt");
    }
    ready_ = true;
    std::cerr << "MiniCPM-o real provider ready: " << params_.model.path << '\n';
  }

  void unload() noexcept override {
    ready_ = false;
    if (context_ != nullptr) {
      omni_free(context_);
      context_ = nullptr;
    }
  }

  [[nodiscard]] bool ready() const noexcept override { return ready_; }

  [[nodiscard]] InferenceResult infer(const InferenceRequest& request,
                                      const std::atomic_bool& cancel) override {
    if (!ready_ || context_ == nullptr) throw std::runtime_error("MiniCPM-o is not loaded");
    if (cancel.load()) return {request.id, {}, true};

    TemporaryMedia media;
    std::string image_path;
    std::string audio_path;
    if (request.frame) {
      const auto path = media.add("frame", request.id, ".bmp");
      write_bgra_bmp(path, *request.frame);
      image_path = path_string(path);
    }
    if (request.audio_16khz_mono) {
      const auto path = media.add("audio", request.id, ".wav");
      write_float_wav(path, *request.audio_16khz_mono);
      audio_path = path_string(path);
    }

    {
      std::lock_guard lock(context_->text_mtx);
      context_->text_queue.clear();
      context_->text_done_flag = false;
    }
    const auto index = static_cast<int>(++round_);
    if (!stream_prefill(context_, audio_path, image_path, index, -1, request.prompt)) {
      throw std::runtime_error("MiniCPM-o prefill failed");
    }
    if (!stream_decode(context_, path_string(fs::temp_directory_path()), index - 1)) {
      throw std::runtime_error("MiniCPM-o decode failed");
    }
    if (cancel.load()) return {request.id, {}, true};

    std::string response;
    {
      std::lock_guard lock(context_->text_mtx);
      while (!context_->text_queue.empty()) {
        auto piece = std::move(context_->text_queue.front());
        context_->text_queue.pop_front();
        if (piece != "__END_OF_TURN__" && piece != "__IS_LISTEN__") response += piece;
      }
    }
    if (response.empty()) throw std::runtime_error("MiniCPM-o returned an empty response");
    return {request.id, std::move(response), false};
  }

 private:
  common_params params_{};
  omni_context* context_{};
  std::uint64_t round_{};
  bool ready_{};
};

}  // namespace

std::unique_ptr<IOmniRuntime> make_real_omni_runtime() {
  return std::make_unique<RealOmniRuntime>();
}

}  // namespace jarvis
