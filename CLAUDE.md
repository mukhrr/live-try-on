# Live Try-On — project context for Claude

This file hands off a research conversation (2026-09-25). Read it first, then `docs/research.md` for the full findings and `docs/plan.md` for phases.

## Goal
Build a **self-hosted, real-time video virtual try-on**: live webcam in, the same person wearing a different garment out. It's inspired by Decart's Lucy 2.5 (a closed, paid API). Start local, commercial use is intended, so **licenses matter**.

**First product target: a Chrome extension, named Toshoyna** (toshoyna.ai; "tosh oyna", the historical word for mirror). Owner, 2026-09-25. The frontend is an extension, not a standalone site. The GPU backend stays server-side.
Flow: on any shop page the user selects a product on screen, and a mirror window opens automatically showing their live webcam feed wearing that product. The product photo is the RV2V reference image.

## Hardware
- **GPU box:** NVIDIA RTX 6000 Pro Blackwell, 96GB. **Not owned (2026-09-25).** Rented by the hour on Modal (`RTX-PRO-6000`). This is where models run. Blackwell needs **PyTorch built for CUDA 12.8+** (`--index-url https://download.pytorch.org/whl/cu128`). Older research repos that pin older torch/CUDA will break.
- **MacBook (Apple Silicon):** no CUDA. Use it for recording clips, writing code, and the frontend. Models don't run here.
- Code lives in the private repo github.com/mukhrr/live-try-on; Modal builds from local files, so nothing needs copying by hand.

## Owner preferences
- Direct, casual communication. No filler.
- **Validate assumptions before writing code.** Measure first, then build.
- Frontend stack: TypeScript, React/Next.js, Tailwind. Backend for ML: Python.

## Current status
- [x] Research: how Lucy is built, open alternatives, model shortlist, licenses
- [x] Helios-Distilled benched on a Modal H100 and dropped (2026-09-25): best case 2.27s per 33-frame chunk vs a 1.38s live budget. Code removed; numbers in `docs/pivot-joyai.md`
- [x] JoyAI-Video-Edit self-hosted on a Modal RTX PRO 6000 (`joyai_modal.py`, `modal serve joyai_modal.py`), 840x480 @ 24 FPS, their own web UI. Cold start ~25 min (compile), warm start ~1m40s with the compile cache on volume `joyai-compile-cache`. 39GB VRAM. Owner tried it live 2026-09-25: "looks good"
- [x] Helios code, bench results and Modal volumes removed (2026-09-27)
- [ ] **NEXT: Toshoyna Chrome extension** talking to the JoyAI server's websocket
- [x] Phase 2 skeleton: `server/` (FastAPI + aiortc, pluggable `FrameProcessor`) and `web/` (Next.js webcam page with pixel-marker latency overlay). Tested on the Mac with headless Chrome and a fake camera: passthrough about 130ms capture-to-display on localhost, and `dummy` at 100ms/frame holds at about 250ms and drops frames instead of queueing
- [ ] Measure the skeleton over the LAN (Mac browser to GPU box) before plugging in a model

## Key decisions so far
1. **Don't train from scratch. Bake-off first.** No open model does real-time *and* garment-faithful try-on. Training (fine-tune/distill) comes only if the bake-off shows a gap worth closing.
2. **Helios-Distilled was tried first and dropped.** Too slow for live even on an H100 (see status).
3. **Model: JoyAI-Video-Edit** (chosen 2026-09-25; `jd-opensource/JoyAI-Video-Edit`, HF `jdopensource/JoyAI-Video-Edit`). Apache 2.0 code and weights, 16B, streaming V2V, and **reference-image garment editing (RV2V)**, e.g. "Put the coat from Image 1 on the model". Reported 840x480@24 FPS on a single RTX PRO 6000, 30 FPS at 720p on a B200. Live webcam demo: https://huggingface.co/spaces/wxDai/joyai-video-edit. Needs custom CUDA ops (`deploy/joyomni_ops`), no Diffusers support. Glass-to-glass latency is unmeasured. Low-latency fallback: StreamDiffusionV2 1.3B (Apache 2.0, SDEdit, text only). CausVid and Rolling Forcing are **non-commercial**.
4. **Earlier fallback idea, superseded by 3:** frame-wise causal models (Causal Forcing, CausVid). **Check their licenses before recommending.**
5. **Avoid for commercial use:** Krea Realtime 14B and Lucy Edit Dev (both non-commercial). Verify MagicTryOn's license before relying on it.
