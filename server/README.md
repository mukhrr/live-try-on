# Server

FastAPI + aiortc. Receives the webcam track, runs each frame through a `FrameProcessor` (`processors.py`), sends it back. Keeps only the newest frame, so a slow processor drops frames instead of adding lag.

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
```

Env:
- `PROCESSOR=passthrough|dummy` (default passthrough). `dummy` tints per garment so you can see it went through the server.
- `SIMULATE_MS=100` with `dummy`: sleeps per frame to mimic model compute.

A real model goes in as another `FrameProcessor`. On a LAN no STUN/TURN is needed; over the internet it will be.
