#ifndef _WIN32
#include "jarvis/unix.hpp"
#include "jarvis/protocol.hpp"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace jarvis::unix {
namespace {
bool read_exact(int fd, std::byte* destination, std::size_t size) {
  while (size) {
    const auto chunk = std::min<size_t>(size, SSIZE_MAX);
    const auto n = ::read(fd, destination, chunk);
    if (n <= 0) return false;
    destination += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

bool write_exact(int fd, const std::byte* source, std::size_t size) {
  while (size) {
    const auto chunk = std::min<size_t>(size, SSIZE_MAX);
    const auto n = ::write(fd, source, chunk);
    if (n <= 0) return false;
    source += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}
} // namespace

struct UnixSocketServer::Impl {
  std::string socket_path;
  Worker& worker;
  std::atomic_bool stop{};
  int listen_fd{-1};
  int client_fd{-1};
  std::mutex write_mutex;
  std::jthread duplex_start_thread;

  Impl(std::string path, Worker& w) : socket_path(std::move(path)), worker(w) {}

  ~Impl() {
    if (client_fd >= 0) { ::close(client_fd); client_fd = -1; }
    if (listen_fd >= 0) { ::close(listen_fd); listen_fd = -1; }
    ::unlink(socket_path.c_str());
  }
};

UnixSocketServer::UnixSocketServer(std::string socket_path, Worker& worker)
    : impl_(std::make_unique<Impl>(std::move(socket_path), worker)) {}

UnixSocketServer::~UnixSocketServer() { request_stop(); }

void UnixSocketServer::request_stop() noexcept {
  impl_->stop = true;
  if (impl_->client_fd >= 0) {
    ::shutdown(impl_->client_fd, SHUT_RDWR);
    ::close(impl_->client_fd);
    impl_->client_fd = -1;
  }
  if (impl_->listen_fd >= 0) {
    ::close(impl_->listen_fd);
    impl_->listen_fd = -1;
  }
}

int UnixSocketServer::run() {
  // Remove stale socket file if it exists
  ::unlink(impl_->socket_path.c_str());

  impl_->listen_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (impl_->listen_fd < 0) {
    return 2;
  }

  // Set close-on-exec
  ::fcntl(impl_->listen_fd, F_SETFD, FD_CLOEXEC);

  struct sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  // Truncate if path is too long
  const auto max_path = sizeof(addr.sun_path) - 1;
  const auto path_len = std::min(impl_->socket_path.size(), max_path);
  std::memcpy(addr.sun_path, impl_->socket_path.c_str(), path_len);
  addr.sun_path[path_len] = '\0';

  if (::bind(impl_->listen_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
    return 2;
  }

  if (::listen(impl_->listen_fd, 1) < 0) {
    return 2;
  }

  // Set listen socket to non-blocking for poll-based accept
  ::fcntl(impl_->listen_fd, F_SETFL, O_NONBLOCK);

  impl_->worker.set_completion([this](InferenceResult result) {
    std::string text = result.cancelled ? std::string{} : std::move(result.text);
    const auto payload = std::span<const std::byte>(
        reinterpret_cast<const std::byte*>(text.data()), text.size());
    const auto response = ipc::encode(
        result.cancelled ? ipc::MessageType::status : ipc::MessageType::result,
        result.id, payload,
        result.cancelled ? static_cast<std::uint32_t>(ipc::StatusCode::cancelled) : 0U);
    std::lock_guard lock(impl_->write_mutex);
    if (impl_->client_fd >= 0) {
      write_exact(impl_->client_fd, response.data(), response.size());
    }
  });

  while (!impl_->stop) {
    // Accept a client connection (blocking with timeout via poll)
    impl_->client_fd = ::accept(impl_->listen_fd, nullptr, nullptr);
    if (impl_->client_fd < 0) {
      if (impl_->stop) break;
      // Retry on transient errors
      if (errno == EINTR || errno == EAGAIN) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        continue;
      }
      return 2;
    }

    // Set client socket to blocking mode
    int flags = ::fcntl(impl_->client_fd, F_GETFL, 0);
    ::fcntl(impl_->client_fd, F_SETFL, flags & ~O_NONBLOCK);

    // Set SO_RCVTIMEO to detect stale connections
    struct timeval tv{};
    tv.tv_sec = 600; // 10 minute timeout
    tv.tv_usec = 0;
    ::setsockopt(impl_->client_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    // Message loop
    while (!impl_->stop) {
      std::vector<std::byte> header(ipc::kHeaderBytes);
      if (!read_exact(impl_->client_fd, header.data(), header.size())) break;

      // Extract declared payload size at byte 20
      std::uint32_t payload_size{};
      std::memcpy(&payload_size, header.data() + 20, sizeof(payload_size));
      if (payload_size > ipc::kMaxPayloadBytes) break;

      std::vector<std::byte> frame = std::move(header);
      frame.resize(ipc::kHeaderBytes + payload_size);
      if (payload_size && !read_exact(impl_->client_fd, frame.data() + ipc::kHeaderBytes, payload_size)) break;

      auto decoded = ipc::decode(frame);
      if (!decoded) break;

      const auto type = decoded.message.header.type;
      const auto id = decoded.message.header.request_id;
      bool response_deferred = false;

      if (type == ipc::MessageType::shutdown) { request_stop(); break; }

      if (type == ipc::MessageType::start) {
        try {
          impl_->worker.start_monitoring(
              make_screencapturekit_desktop_capture(),
              make_coreaudio_capture());
        } catch (...) {
          const auto response = ipc::encode(ipc::MessageType::error, id, {});
          std::lock_guard lock(impl_->write_mutex);
          write_exact(impl_->client_fd, response.data(), response.size());
          continue;
        }
      }

      if (type == ipc::MessageType::stop) impl_->worker.stop_monitoring();
      if (type == ipc::MessageType::cancel) impl_->worker.cancel(id);

      if (type == ipc::MessageType::submit) {
        std::string prompt(
            reinterpret_cast<const char*>(decoded.message.payload.data()),
            decoded.message.payload.size());
        impl_->worker.submit_prompt(id, std::move(prompt));
      }

      if (type == ipc::MessageType::configure_game) {
        std::string value(
            reinterpret_cast<const char*>(decoded.message.payload.data()),
            decoded.message.payload.size());
        const auto separator = value.find('\0');
        impl_->worker.set_game_profile(
            value.substr(0, separator),
            separator == std::string::npos ? "" : value.substr(separator + 1));
      }

      if (type == ipc::MessageType::start_duplex) {
        std::string value(
            reinterpret_cast<const char*>(decoded.message.payload.data()),
            decoded.message.payload.size());
        const auto separator = value.find('\0');
        const auto session_id = value.substr(0, separator);
        const auto instruction = separator == std::string::npos
                                     ? std::string{}
                                     : value.substr(separator + 1);
        if (impl_->duplex_start_thread.joinable()) impl_->duplex_start_thread.join();
        response_deferred = true;
        impl_->duplex_start_thread = std::jthread(
            [this, id, session_id, instruction](std::stop_token) {
              const bool started = impl_->worker.start_duplex(session_id, instruction);
              std::vector<std::byte> response;
              if (started) {
                response = ipc::encode(ipc::MessageType::status, id, {});
              } else {
                constexpr std::string_view error =
                    R"({"error":"unable to start duplex task; monitoring was stopped or enough GPU memory is unavailable"})";
                const auto payload = std::span<const std::byte>(
                    reinterpret_cast<const std::byte*>(error.data()), error.size());
                response = ipc::encode(ipc::MessageType::error, id, payload);
              }
              std::lock_guard lock(impl_->write_mutex);
              if (impl_->client_fd >= 0) {
                write_exact(impl_->client_fd, response.data(), response.size());
              }
            });
      }

      if (type == ipc::MessageType::stop_duplex) impl_->worker.stop_duplex();

      if (type == ipc::MessageType::hello || type == ipc::MessageType::start ||
          type == ipc::MessageType::stop || type == ipc::MessageType::cancel ||
          type == ipc::MessageType::submit || type == ipc::MessageType::configure_game ||
          type == ipc::MessageType::start_duplex || type == ipc::MessageType::stop_duplex) {
        if (response_deferred) continue;
        const auto response = ipc::encode(ipc::MessageType::status, id, {});
        std::lock_guard lock(impl_->write_mutex);
        if (!write_exact(impl_->client_fd, response.data(), response.size())) break;
      }
    }

    // Disconnect client
    {
      std::lock_guard lock(impl_->write_mutex);
      if (impl_->client_fd >= 0) {
        ::shutdown(impl_->client_fd, SHUT_RDWR);
        ::close(impl_->client_fd);
        impl_->client_fd = -1;
      }
    }
  }

  return 0;
}

// macOS capture implementations are in macos/screen_capture.mm and macos/audio_capture.mm
// screen_capture.mm and audio_capture.mm

} // namespace jarvis::unix
#endif
