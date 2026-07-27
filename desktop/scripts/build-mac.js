#!/usr/bin/env node
"use strict";

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(ROOT, "..");

function run(command, options = {}) {
  console.log(`> ${command}`);
  execSync(command, { stdio: "inherit", cwd: options.cwd || ROOT, ...options });
}

function main() {
  console.log("=== AI Jarvis macOS Build ===\n");

  // Step 1: Build the native C++ worker
  console.log("[1/4] Building native C++ worker with Metal support...");
  const buildDir = path.join(PROJECT_ROOT, "build", "native-macos");
  fs.mkdirSync(buildDir, { recursive: true });

  run(`cmake -S "${PROJECT_ROOT}" -B "${buildDir}" -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_CUDA=OFF -DJARVIS_RUNTIME_ENABLE_UPSTREAM=ON`);
  run(`cmake --build "${buildDir}" --config Release --parallel`);

  // Step 2: Prepare runtime directory
  console.log("\n[2/4] Preparing runtime directory...");
  const runtimeDir = path.join(ROOT, "build", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Copy native worker
  const workerBinary = path.join(buildDir, "native", "jarvis-native-worker");
  if (fs.existsSync(workerBinary)) {
    fs.copyFileSync(workerBinary, path.join(runtimeDir, "jarvis-native-worker"));
    fs.chmodSync(path.join(runtimeDir, "jarvis-native-worker"), 0o755);
    console.log("  Copied jarvis-native-worker");
  } else {
    console.error("  Warning: jarvis-native-worker not found, trying stub runtime...");
    // Try building with stub runtime
    run(`cmake -S "${PROJECT_ROOT}" -B "${buildDir}" -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=OFF -DJARVIS_ENABLE_STUB_RUNTIME=ON`);
    run(`cmake --build "${buildDir}" --config Release --parallel`);
    if (fs.existsSync(workerBinary)) {
      fs.copyFileSync(workerBinary, path.join(runtimeDir, "jarvis-native-worker"));
      fs.chmodSync(path.join(runtimeDir, "jarvis-native-worker"), 0o755);
    }
  }

  // Copy reference audio if exists
  const refAudio = path.join(buildDir, "default_ref_audio.wav");
  if (fs.existsSync(refAudio)) {
    fs.copyFileSync(refAudio, path.join(runtimeDir, "default_ref_audio.wav"));
  }

  // Step 3: Freeze Python backend
  console.log("\n[3/4] Freezing Python backend with PyInstaller...");
  const venvDir = path.join(PROJECT_ROOT, ".venv");
  const pyinstallerDir = path.join(runtimeDir, "jarvis-launcher");

  // Ensure venv exists
  if (!fs.existsSync(venvDir)) {
    run("python3 -m venv .venv", { cwd: PROJECT_ROOT });
  }

  // Install dependencies
  run(`${path.join(venvDir, "bin", "pip")} install -e "${PROJECT_ROOT}[packaging]" --quiet`);

  // Run PyInstaller
  run(`${path.join(venvDir, "bin", "python")} -m PyInstaller \
    --name jarvis-launcher \
    --distpath "${path.dirname(pyinstallerDir)}" \
    --workpath "${path.join(buildDir, "pyinstaller-work")}" \
    --specpath "${buildDir}" \
    --onedir \
    --noconfirm \
    --clean \
    --paths "${path.join(PROJECT_ROOT, "src")}" \
    --hidden-import jarvis_backend \
    --hidden-import jarvis_backend.app \
    --hidden-import jarvis_backend.packaged_launcher \
    --hidden-import jarvis_backend.model_download \
    --hidden-import jarvis_backend.native.unix_client \
    "${path.join(PROJECT_ROOT, "src", "jarvis_backend", "packaged_launcher.py")}"`);

  // Step 4: Build Electron DMG
  console.log("\n[4/4] Building Electron DMG...");
  run("npx electron-builder --mac --arm64");

  console.log("\n=== Build Complete ===");
  console.log(`DMG output: ${path.join(ROOT, "dist")}`);
}

try {
  main();
} catch (error) {
  console.error("\nBuild failed:", error.message);
  process.exit(1);
}
