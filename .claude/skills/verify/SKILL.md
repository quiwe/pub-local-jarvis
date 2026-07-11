---
name: verify
summary: Drive the local FastAPI control-plane surface and capture HTTP evidence.
---

# Verify AI Jarvis Backend

1. Install once with `python -m pip install -e ".[test]"`.
2. Start an isolated server: `python -m uvicorn jarvis_backend.app:app --host 127.0.0.1 --port 18743`.
3. Drive `/api/v1/health`, `/commands`, three `/scene/observations`, course start/finish/query, and the memory-clear confirmation error through HTTP.
4. Capture response bodies. Remove verification-only `courses/`, `memory/`, and Desktop course artifacts afterward.
5. Native runtime verification is blocked unless CMake/MSVC and the reviewed MiniCPM-o provider are installed; never report the development stub as inference evidence.
