# Contributing to AI Jarvis

Thank you for contributing. Keep changes focused, preserve the local-first privacy model, and do
not commit screen captures, audio, model weights, API keys, local memory, course data, or runtime
logs.

## Development setup

Development targets 64-bit Windows 10/11 and requires Python 3.12+, Git, CMake 3.24+, Visual
Studio 2022 C++ Build Tools, Node.js LTS, and npm. The source launcher can install missing build
tools with `winget`, but contributors should understand every tool installed on their machine.

```powershell
cd desktop
npm run deps:install
cd ..
.\start-real.cmd
```

## Verification

Run the checks relevant to the code you changed. Before opening a pull request, run the complete
suite when practical:

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pytest
cd desktop
npm test
cd ..
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

Do not commit generated files from `build/`, `desktop/dist/`, `.runtime/`, `models/`, `memory/`,
`courses/`, or `desktop/qa-output/`.

## Pull requests

- Explain the user-visible behavior and the reason for the change.
- Add focused tests for bug fixes and behavioral changes.
- Keep third-party runtime changes in a checksum-pinned patch under `third_party/runtime/patches/`.
- Preserve loopback-only backend defaults and the screen/audio privacy controls.
- Document new network access, persisted data, or external API behavior.
