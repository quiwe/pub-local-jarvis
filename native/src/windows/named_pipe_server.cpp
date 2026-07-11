#ifdef _WIN32
#include "jarvis/windows.hpp"
#include "jarvis/protocol.hpp"

#include <Windows.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace jarvis::win {
namespace {
bool read_exact(HANDLE pipe, std::byte* destination, std::size_t size) {
  while (size) {
    DWORD read{};
    const auto chunk = static_cast<DWORD>(std::min<std::size_t>(size, MAXDWORD));
    if (!ReadFile(pipe, destination, chunk, &read, nullptr) || read == 0) return false;
    destination += read; size -= read;
  }
  return true;
}
bool write_exact(HANDLE pipe, const std::byte* source, std::size_t size) {
  while (size) {
    DWORD written{};
    const auto chunk = static_cast<DWORD>(std::min<std::size_t>(size, MAXDWORD));
    if (!WriteFile(pipe, source, chunk, &written, nullptr) || written == 0) return false;
    source += written; size -= written;
  }
  return true;
}
} // namespace
struct NamedPipeServer::Impl {
  std::wstring name; Worker& worker; std::atomic_bool stop{}; HANDLE pipe{INVALID_HANDLE_VALUE};
  std::mutex write_mutex;
  Impl(std::wstring n, Worker& w) : name(std::move(n)), worker(w) {}
};
NamedPipeServer::NamedPipeServer(std::wstring name, Worker& worker) : impl_(std::make_unique<Impl>(std::move(name), worker)) {}
NamedPipeServer::~NamedPipeServer() { request_stop(); }
void NamedPipeServer::request_stop() noexcept {
  impl_->stop = true;
  if (impl_->pipe != INVALID_HANDLE_VALUE) { CancelIoEx(impl_->pipe, nullptr); DisconnectNamedPipe(impl_->pipe); }
}
int NamedPipeServer::run() {
  impl_->worker.set_completion([this](InferenceResult result) {
    std::string text = result.cancelled ? std::string{} : std::move(result.text);
    const auto payload = std::span<const std::byte>(reinterpret_cast<const std::byte*>(text.data()), text.size());
    const auto response = ipc::encode(result.cancelled ? ipc::MessageType::status : ipc::MessageType::result,
                                      result.id, payload);
    std::lock_guard lock(impl_->write_mutex);
    if (impl_->pipe != INVALID_HANDLE_VALUE) write_exact(impl_->pipe, response.data(), response.size());
  });
  while (!impl_->stop) {
    impl_->pipe = CreateNamedPipeW(impl_->name.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 64 * 1024, 64 * 1024, 0, nullptr);
    if (impl_->pipe == INVALID_HANDLE_VALUE) return 2;
    if (!ConnectNamedPipe(impl_->pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) {
      CloseHandle(impl_->pipe); impl_->pipe = INVALID_HANDLE_VALUE; if (impl_->stop) break; continue;
    }
    while (!impl_->stop) {
      DWORD available{};
      if (!PeekNamedPipe(impl_->pipe, nullptr, 0, nullptr, &available, nullptr)) break;
      if (available < ipc::kHeaderBytes) {
        Sleep(10);
        continue;
      }
      std::vector<std::byte> header(ipc::kHeaderBytes);
      if (!read_exact(impl_->pipe, header.data(), header.size())) break;
      // First decode header with zero payload by extracting declared size at byte 20.
      std::uint32_t payload_size{}; std::memcpy(&payload_size, header.data() + 20, sizeof(payload_size));
      if (payload_size > ipc::kMaxPayloadBytes) break;
      std::vector<std::byte> frame = std::move(header); frame.resize(ipc::kHeaderBytes + payload_size);
      if (payload_size && !read_exact(impl_->pipe, frame.data() + ipc::kHeaderBytes, payload_size)) break;
      auto decoded = ipc::decode(frame);
      if (!decoded) break;
      const auto type = decoded.message.header.type; const auto id = decoded.message.header.request_id;
      if (type == ipc::MessageType::shutdown) { request_stop(); break; }
      if (type == ipc::MessageType::start) {
        try {
          impl_->worker.start_monitoring(make_dxgi_desktop_capture(), make_wasapi_loopback_capture());
        } catch (...) {
          const auto response = ipc::encode(ipc::MessageType::error, id, {});
          std::lock_guard lock(impl_->write_mutex);
          write_exact(impl_->pipe, response.data(), response.size());
          continue;
        }
      }
      if (type == ipc::MessageType::stop) impl_->worker.stop_monitoring();
      if (type == ipc::MessageType::cancel) impl_->worker.cancel(id);
      if (type == ipc::MessageType::submit) {
        std::string prompt(reinterpret_cast<const char*>(decoded.message.payload.data()), decoded.message.payload.size());
        impl_->worker.submit({InferenceRequest{.id=id, .prompt=std::move(prompt)}, Priority::interactive});
      }
      if (type == ipc::MessageType::hello || type == ipc::MessageType::start ||
          type == ipc::MessageType::stop || type == ipc::MessageType::cancel ||
          type == ipc::MessageType::submit) {
        const auto response = ipc::encode(ipc::MessageType::status, id, {});
        std::lock_guard lock(impl_->write_mutex);
        if (!write_exact(impl_->pipe, response.data(), response.size())) break;
      }
    }
    {
      std::lock_guard lock(impl_->write_mutex);
      if (impl_->pipe != INVALID_HANDLE_VALUE) {
        FlushFileBuffers(impl_->pipe); DisconnectNamedPipe(impl_->pipe); CloseHandle(impl_->pipe);
        impl_->pipe = INVALID_HANDLE_VALUE;
      }
    }
  }
  return 0;
}
} // namespace jarvis::win
#endif
