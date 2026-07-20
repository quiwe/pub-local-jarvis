# Third-Party Notices

## llama.cpp-omni / llama.cpp / ggml runtime reference

The optional native MiniCPM-o runtime provider is derived from and designed to integrate with:

- Project: `tc-mb/llama.cpp-omni`
- Repository: https://github.com/tc-mb/llama.cpp-omni
- Pinned revision: `b9d15b83ee353b2eaeee4d9318c98a35a1347486`
- License: MIT
- Copyright: Copyright (c) 2023-2026 The ggml authors

The full MIT text retained for this component is in
`third_party/runtime/LICENSE.llama.cpp-omni`. Acquisition metadata and archive
verification are in `third_party/runtime/VENDOR.json`.

The SHA-256-verified source snapshot is retained under
`third_party/runtime/vendor`. The real launcher applies the checksum-pinned
text-input patch and compiles the LLM/VPM/APM provider with TTS loading disabled.
Stub builds and the standalone runtime boundary do not compile that provider.

## Model weights

MiniCPM-o model weights and converted GGUF files are not covered by this source
notice and are not distributed by this repository. Users and distributors must
review the exact model card and license before downloading, using commercially,
or redistributing weights.
