#pragma once

#ifndef _WIN32

#include "jarvis/capture.hpp"
#include "jarvis/worker.hpp"

#include <atomic>
#include <memory>
#include <string>

namespace jarvis::unix {

class UnixSocketServer {
 public:
  UnixSocketServer(std::string socket_path, Worker& worker);
  ~UnixSocketServer();
  UnixSocketServer(const UnixSocketServer&) = delete;
  UnixSocketServer& operator=(const UnixSocketServer&) = delete;

  int run();
  void request_stop() noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

[[nodiscard]] std::unique_ptr<IDesktopCapture> make_screencapturekit_desktop_capture();
[[nodiscard]] std::unique_ptr<IAudioCapture> make_coreaudio_capture();

} // namespace jarvis::unix

#endif
