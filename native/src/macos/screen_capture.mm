#ifdef __APPLE__
/**
 * macOS ScreenCaptureKit-based desktop capture.
 *
 * Uses ScreenCaptureKit (macOS 12.3+) for efficient screen capture.
 * Falls back to a simple approach on older macOS.
 */

#include "jarvis/capture.hpp"

#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

// Shared state between the delegate and the capture class
static std::mutex g_frame_mutex;
static std::condition_variable g_frame_cv;
static bool g_has_frame = false;
static jarvis::VideoFrame g_latest_frame;
static std::atomic_bool g_capture_running{false};

// Objective-C delegate must be at global scope
API_AVAILABLE(macos(12.3))
@interface JarvisScreenCaptureDelegate : NSObject <SCStreamOutput>
@end

@implementation JarvisScreenCaptureDelegate

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  if (!g_capture_running.load()) return;
  if (type != SCStreamOutputTypeScreen) return;

  CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (imageBuffer == nullptr) return;

  CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

  jarvis::VideoFrame frame;
  frame.width = static_cast<std::uint32_t>(CVPixelBufferGetWidth(imageBuffer));
  frame.height = static_cast<std::uint32_t>(CVPixelBufferGetHeight(imageBuffer));
  frame.row_pitch = static_cast<std::uint32_t>(CVPixelBufferGetBytesPerRow(imageBuffer));

  const auto* baseAddress =
      static_cast<const std::byte*>(CVPixelBufferGetBaseAddress(imageBuffer));
  if (baseAddress != nullptr) {
    const auto totalSize = static_cast<std::size_t>(frame.row_pitch) * frame.height;
    frame.bgra.assign(baseAddress, baseAddress + totalSize);
  }

  CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

  auto now = std::chrono::steady_clock::now();
  frame.timestamp_100ns = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          now.time_since_epoch())
          .count() /
      100);

  {
    std::lock_guard lock(g_frame_mutex);
    g_latest_frame = std::move(frame);
    g_has_frame = true;
  }
  g_frame_cv.notify_one();
}

@end

// C++ capture class
namespace {

class SCStreamCapture : public jarvis::IDesktopCapture {
 public:
  SCStreamCapture() = default;
  ~SCStreamCapture() override { stop(); }

  void start() override {
    if (running_.load()) return;
    running_.store(true);
    g_capture_running.store(true);

    // Get shareable content
    __block dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block SCShareableContent* content = nil;

    [SCShareableContent
        getShareableContentWithCompletionHandler:^(SCShareableContent* c,
                                                   NSError* error) {
          content = c;
          dispatch_semaphore_signal(sem);
        }];

    dispatch_semaphore_wait(sem,
                            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));

    if (content == nil) {
      running_.store(false);
      g_capture_running.store(false);
      throw std::runtime_error("failed to get shareable content");
    }

    // Find main display
    SCDisplay* mainDisplay = nil;
    for (SCDisplay* display in content.displays) {
      if (display.displayID == CGMainDisplayID()) {
        mainDisplay = display;
        break;
      }
    }
    if (mainDisplay == nil && content.displays.count > 0) {
      mainDisplay = content.displays.firstObject;
    }
    if (mainDisplay == nil) {
      running_.store(false);
      g_capture_running.store(false);
      throw std::runtime_error("no display found");
    }

    // Configure stream
    SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
    config.width = mainDisplay.width;
    config.height = mainDisplay.height;
    config.pixelFormat = kCVPixelFormatType_32BGRA;
    config.minimumFrameInterval = CMTimeMake(1, 10);  // 10 fps
    config.queueDepth = 3;

    SCContentFilter* filter =
        [[SCContentFilter alloc] initWithDisplay:mainDisplay
                                excludingWindows:@[]];

    capture_stream_ = [[SCStream alloc] initWithFilter:filter
                                         configuration:config
                                              delegate:nil];

    capture_delegate_ = [[JarvisScreenCaptureDelegate alloc] init];
    NSError* addError = nil;
    [capture_stream_ addStreamOutput:capture_delegate_
                                 type:SCStreamOutputTypeScreen
                       sampleHandlerQueue:dispatch_get_main_queue()
                                    error:&addError];

    [capture_stream_ startCaptureWithCompletionHandler:^(NSError* error) {
      if (error != nil) {
        NSLog(@"Screen capture start error: %@", error);
      }
    }];
  }

  void stop() noexcept override {
    running_.store(false);
    g_capture_running.store(false);
    if (capture_stream_ != nil) {
      [capture_stream_ stopCaptureWithCompletionHandler:^(NSError*) {}];
      capture_stream_ = nil;
    }
    capture_delegate_ = nil;
    {
      std::lock_guard lock(g_frame_mutex);
      g_has_frame = false;
    }
  }

  std::optional<jarvis::VideoFrame> next_frame(
      std::uint32_t timeout_ms) override {
    if (!running_.load()) return std::nullopt;

    std::unique_lock lock(g_frame_mutex);
    if (!g_has_frame) {
      if (timeout_ms == 0) return std::nullopt;
      g_frame_cv.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                          [] { return g_has_frame || !g_capture_running.load(); });
      if (!g_has_frame || !running_.load()) return std::nullopt;
    }

    jarvis::VideoFrame frame = std::move(g_latest_frame);
    g_has_frame = false;
    return frame;
  }

 private:
  SCStream* capture_stream_ = nil;
  JarvisScreenCaptureDelegate* capture_delegate_ = nil;
  std::atomic_bool running_{false};
};

// Fallback for older macOS
class FallbackCapture : public jarvis::IDesktopCapture {
 public:
  void start() override {}
  void stop() noexcept override {}
  std::optional<jarvis::VideoFrame> next_frame(std::uint32_t) override {
    return std::nullopt;
  }
};

}  // namespace

namespace jarvis::unix {

std::unique_ptr<IDesktopCapture> make_screencapturekit_desktop_capture() {
  if (@available(macOS 12.3, *)) {
    return std::make_unique<SCStreamCapture>();
  }
  return std::make_unique<FallbackCapture>();
}

}  // namespace jarvis::unix

#endif
