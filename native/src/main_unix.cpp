#ifndef _WIN32
#include "jarvis/unix.hpp"
#include "jarvis/worker.hpp"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

int main(int argc, char** argv) {
  const std::string socket_path = argc > 1 ? argv[1] : "/tmp/AIJarvis.Worker.sock";
  const std::string model = argc > 2 ? argv[2] : "";
  if (model.empty()) {
    std::cerr << "model path is required\n";
    return 2;
  }

#ifdef JARVIS_ENABLE_STUB_RUNTIME
  auto runtime = jarvis::make_stub_omni_runtime();
#elif defined(JARVIS_HAS_REAL_RUNTIME)
  auto runtime = jarvis::make_real_omni_runtime();
#else
#error "A production worker must link the real runtime provider"
#endif

  jarvis::Worker worker(std::move(runtime));
  if (!worker.start(model)) {
    std::cerr << "failed to start worker runtime\n";
    return 1;
  }

  jarvis::unix::UnixSocketServer server(socket_path, worker);
  return server.run();
}
#endif
