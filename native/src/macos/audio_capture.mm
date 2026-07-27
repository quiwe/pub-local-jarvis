#ifdef __APPLE__
/**
 * macOS CoreAudio-based audio capture.
 *
 * Captures audio from the default input device (microphone).
 * For system audio loopback, ScreenCaptureKit (macOS 12.3+) or a
 * virtual audio device would be needed.
 */

#include "jarvis/audio.hpp"
#include "jarvis/capture.hpp"

#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace jarvis::unix {

namespace {
constexpr std::uint32_t kSampleRate = 44100;
constexpr std::uint32_t kChannels = 1;
constexpr std::uint32_t kFramesPerBuffer = 1024;

struct AudioBuffer {
  std::vector<float> samples;
  std::mutex mutex;
};
} // namespace

class CoreAudioCapture : public IAudioCapture {
 public:
  CoreAudioCapture() = default;
  ~CoreAudioCapture() override { stop(); }

  void start() override {
    if (running_.load()) return;

    // Set up AudioStreamBasicDescription
    AudioStreamBasicDescription format{};
    format.mSampleRate = kSampleRate;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    format.mBitsPerChannel = 32;
    format.mChannelsPerFrame = kChannels;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = format.mChannelsPerFrame * (format.mBitsPerChannel / 8);
    format.mBytesPerPacket = format.mBytesPerFrame * format.mFramesPerPacket;

    // Set up AudioComponent
    AudioComponentDescription desc{};
    desc.componentType = kAudioUnitType_Output;
    desc.componentSubType = kAudioUnitSubType_HALOutput;
    desc.componentManufacturer = kAudioUnitManufacturer_Apple;

    AudioComponent component = AudioComponentFindNext(nullptr, &desc);
    if (component == nullptr) {
      throw std::runtime_error("failed to find audio component");
    }

    OSStatus status = AudioComponentInstanceNew(component, &audio_unit_);
    if (status != noErr) {
      throw std::runtime_error("failed to create audio unit");
    }

    // Enable input
    UInt32 enable_input = 1;
    status = AudioUnitSetProperty(audio_unit_, kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Input, 1, &enable_input, sizeof(enable_input));
    if (status != noErr) {
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to enable audio input");
    }

    // Disable output
    UInt32 disable_output = 0;
    status = AudioUnitSetProperty(audio_unit_, kAudioOutputUnitProperty_EnableIO,
                                  kAudioUnitScope_Output, 0, &disable_output, sizeof(disable_output));
    if (status != noErr) {
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to disable audio output");
    }

    // Set format
    status = AudioUnitSetProperty(audio_unit_, kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Output, 1, &format, sizeof(format));
    if (status != noErr) {
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to set audio format");
    }

    // Set callback
    AURenderCallbackStruct callback_struct{};
    callback_struct.inputProc = audioCallback;
    callback_struct.inputProcRefCon = this;
    status = AudioUnitSetProperty(audio_unit_, kAudioOutputUnitProperty_SetInputCallback,
                                  kAudioUnitScope_Global, 0, &callback_struct, sizeof(callback_struct));
    if (status != noErr) {
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to set audio callback");
    }

    status = AudioUnitInitialize(audio_unit_);
    if (status != noErr) {
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to initialize audio unit");
    }

    status = AudioOutputUnitStart(audio_unit_);
    if (status != noErr) {
      AudioUnitUninitialize(audio_unit_);
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
      throw std::runtime_error("failed to start audio unit");
    }

    running_.store(true);
  }

  void stop() noexcept override {
    running_.store(false);
    if (audio_unit_ != nullptr) {
      AudioOutputUnitStop(audio_unit_);
      AudioUnitUninitialize(audio_unit_);
      AudioComponentInstanceDispose(audio_unit_);
      audio_unit_ = nullptr;
    }
  }

  std::optional<audio::PcmBlock> next_block(std::uint32_t timeout_ms) override {
    if (!running_.load()) return std::nullopt;

    // Wait for data with timeout
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
      std::vector<float> samples;
      {
        std::lock_guard lock(buffer_.mutex);
        if (!buffer_.samples.empty()) {
          samples = std::move(buffer_.samples);
          buffer_.samples.clear();
        }
      }
      if (!samples.empty()) {
        audio::PcmBlock block;
        block.interleaved = std::move(samples);
        block.format.sample_rate = kSampleRate;
        block.format.channels = kChannels;
        return block;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return std::nullopt;
  }

 private:
  static OSStatus audioCallback(void* inRefCon,
                                AudioUnitRenderActionFlags* ioActionFlags,
                                const AudioTimeStamp* inTimeStamp,
                                UInt32 inBusNumber,
                                UInt32 inNumberFrames,
                                AudioBufferList* ioData) {
    auto* self = static_cast<CoreAudioCapture*>(inRefCon);
    if (!self->running_.load()) return noErr;

    // Allocate buffer list for input
    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = kChannels;
    bufferList.mBuffers[0].mDataByteSize = inNumberFrames * sizeof(float);
    std::vector<float> tempBuffer(inNumberFrames);
    bufferList.mBuffers[0].mData = tempBuffer.data();

    OSStatus status = AudioUnitRender(self->audio_unit_, ioActionFlags, inTimeStamp,
                                      inBusNumber, inNumberFrames, &bufferList);
    if (status != noErr) return status;

    // Copy to our buffer
    {
      std::lock_guard lock(self->buffer_.mutex);
      self->buffer_.samples.insert(self->buffer_.samples.end(),
                                   tempBuffer.begin(), tempBuffer.end());
    }

    return noErr;
  }

  AudioUnit audio_unit_ = nullptr;
  AudioBuffer buffer_;
  std::atomic_bool running_{false};
};

std::unique_ptr<IAudioCapture> make_coreaudio_capture() {
  return std::make_unique<CoreAudioCapture>();
}

} // namespace jarvis::unix

#endif
