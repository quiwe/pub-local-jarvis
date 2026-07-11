#ifdef _WIN32
#include "jarvis/windows.hpp"

#include <Windows.h>

#include <iostream>
#include <string>
#include <utility>

int wmain(int argc, wchar_t** argv) {
  const std::wstring pipe = argc > 1 ? argv[1] : LR"(\\.\pipe\AIJarvis.Worker.v1)";
  const std::string model = argc > 2 ? std::string(argv[2], argv[2] + wcslen(argv[2])) : "";
  if (model.empty()) { std::cerr << "model path is required\n"; return 2; }
#ifdef JARVIS_ENABLE_STUB_RUNTIME
  auto runtime = jarvis::make_stub_omni_runtime();
#elif defined(JARVIS_HAS_REAL_RUNTIME)
  auto runtime = jarvis::make_real_omni_runtime();
#else
#error "A production worker must link the real runtime provider"
#endif
  jarvis::Worker worker(std::move(runtime));
  if (!worker.start(model)) { std::cerr << "failed to start worker runtime\n"; return 1; }
  jarvis::win::NamedPipeServer server(pipe, worker);
  return server.run();
}
#endif
