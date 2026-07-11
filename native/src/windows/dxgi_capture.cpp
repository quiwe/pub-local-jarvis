#ifdef _WIN32
#include "jarvis/windows.hpp"

#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <chrono>
#include <cstring>
#include <stdexcept>

namespace jarvis::win {
using Microsoft::WRL::ComPtr;
namespace {
void check(HRESULT hr, const char* what) { if (FAILED(hr)) throw std::runtime_error(what); }
class DxgiDesktopCapture final : public IDesktopCapture {
 public:
  void start() override {
    if (duplication_) return;
    D3D_FEATURE_LEVEL level{};
    check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                            nullptr, 0, D3D11_SDK_VERSION, &device_, &level, &context_), "D3D11CreateDevice failed");
    ComPtr<IDXGIDevice> dxgi_device; check(device_.As(&dxgi_device), "IDXGIDevice unavailable");
    ComPtr<IDXGIAdapter> adapter; check(dxgi_device->GetAdapter(&adapter), "GetAdapter failed");
    ComPtr<IDXGIOutput> output; check(adapter->EnumOutputs(0, &output), "no desktop output");
    ComPtr<IDXGIOutput1> output1; check(output.As(&output1), "IDXGIOutput1 unavailable");
    check(output1->DuplicateOutput(device_.Get(), &duplication_), "DuplicateOutput failed");
  }
  void stop() noexcept override { staging_.Reset(); duplication_.Reset(); context_.Reset(); device_.Reset(); }
  std::optional<VideoFrame> next_frame(std::uint32_t timeout_ms) override {
    if (!duplication_) throw std::runtime_error("desktop capture not started");
    DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
    const auto hr = duplication_->AcquireNextFrame(timeout_ms, &info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return std::nullopt;
    if (hr == DXGI_ERROR_ACCESS_LOST) { stop(); start(); return std::nullopt; }
    check(hr, "AcquireNextFrame failed");
    struct Release { IDXGIOutputDuplication* d; ~Release() { d->ReleaseFrame(); } } release{duplication_.Get()};
    ComPtr<ID3D11Texture2D> texture; check(resource.As(&texture), "frame texture unavailable");
    D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
    if (!staging_ || desc.Width != width_ || desc.Height != height_) {
      desc.BindFlags = 0; desc.MiscFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ; desc.Usage = D3D11_USAGE_STAGING;
      staging_.Reset(); check(device_->CreateTexture2D(&desc, nullptr, &staging_), "staging texture failed");
      width_ = desc.Width; height_ = desc.Height;
    }
    context_->CopyResource(staging_.Get(), texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{}; check(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Map failed");
    struct Unmap { ID3D11DeviceContext* c; ID3D11Resource* r; ~Unmap() { c->Unmap(r, 0); } } unmap{context_.Get(), staging_.Get()};
    VideoFrame frame; frame.width = width_; frame.height = height_; frame.row_pitch = width_ * 4U;
    if (info.LastPresentTime.QuadPart > 0) {
      LARGE_INTEGER frequency{}; QueryPerformanceFrequency(&frequency);
      const auto ticks = static_cast<std::uint64_t>(info.LastPresentTime.QuadPart);
      frame.timestamp_100ns = (ticks / static_cast<std::uint64_t>(frequency.QuadPart)) * 10'000'000ULL +
          (ticks % static_cast<std::uint64_t>(frequency.QuadPart)) * 10'000'000ULL /
              static_cast<std::uint64_t>(frequency.QuadPart);
    }
    frame.bgra.resize(std::size_t(frame.row_pitch) * frame.height);
    for (std::uint32_t y = 0; y < frame.height; ++y)
      std::memcpy(frame.bgra.data() + std::size_t(y) * frame.row_pitch,
                  static_cast<const std::byte*>(mapped.pData) + std::size_t(y) * mapped.RowPitch, frame.row_pitch);
    return frame;
  }
 private:
  ComPtr<ID3D11Device> device_; ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_; ComPtr<ID3D11Texture2D> staging_;
  std::uint32_t width_{}, height_{};
};
} // namespace
std::unique_ptr<IDesktopCapture> make_dxgi_desktop_capture() { return std::make_unique<DxgiDesktopCapture>(); }
} // namespace jarvis::win
#endif
