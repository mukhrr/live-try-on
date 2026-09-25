# Live Try-On — project context for Claude

This file hands off a research conversation (2026-09-25). Read it first, then `docs/research.md` for the full findings and `docs/plan.md` for phases.

## Goal
Build a **self-hosted, real-time video virtual try-on**: live webcam in, the same person wearing a different garment out. It's inspired by Decart's Lucy 2.5 (a closed, paid API). Start local, commercial use is intended, so **licenses matter**.

## Hardware
- **GPU box:** NVIDIA RTX 6000 Pro Blackwell, 96GB. This is where models run. Blackwell needs **PyTorch built for CUDA 12.8+** (`--index-url https://download.pytorch.org/whl/cu128`). Older research repos that pin older torch/CUDA will break.
- **MacBook (Apple Silicon):** no CUDA. Use it for recording clips, writing code, and the frontend. Models don't run here.
- The two machines are separate. Copy this folder to the GPU box (scp, or better, a git repo).

## Owner preferences
- Direct, casual communication. No filler.
- **Validate assumptions before writing code.** Measure first, then build.
- Frontend stack: TypeScript, React/Next.js, Tailwind. Backend for ML: Python.

## Current status
- [x] Research: how Lucy is built, open alternatives, model shortlist, licenses
- [x] Wrote `helios_bench.py` + `README.md`. **Not run yet** (it was written without a GPU available, so argument names come from the Helios model card and are unverified)
- [ ] **NEXT: run the sanity check on the GPU box**: `python helios_bench.py --sanity`
- [ ] Record a hard test clip (see README) and run the full bench
- [ ] Read the results and decide using the decision table in README.md

## Key decisions so far
1. **Don't train from scratch. Bake-off first.** No open model does real-time *and* garment-faithful try-on. Training (fine-tune/distill) comes only if the bake-off shows a gap worth closing.
2. **First model: Helios-Distilled** (PKU-YuanGroup, `BestWishYsh/Helios-Distilled`)
   - Apache 2.0, based on Wan2.1-T2V-14B (also Apache 2.0). Commercial use is OK.
   - Supports V2V natively and ships a Diffusers `HeliosPyramidPipeline`. Reported 19.5 FPS on an H100. Group offload goes down to ~6GB VRAM.
   - **Known risk 1:** V2V is weaker than T2V; the authors say so. Tune `video_noise_sigma_min/max` if needed.
   - **Known risk 2:** it generates in **33-frame chunks**, so live latency is roughly 1.4s of buffering plus compute. That's likely 1.5–2s total, versus Lucy's under 40ms. The bench measures this.
3. **Fallback if latency is the blocker:** frame-wise causal models (Causal Forcing, CausVid). **Check their licenses before recommending.**
4. **Avoid for commercial use:** Krea Realtime 14B and Lucy Edit Dev (both non-commercial). Verify MagicTryOn's license before relying on it.

## If the bench script fails
The pipeline's arguments were taken from the model card, not tested. Check `inspect.signature(HeliosPyramidPipeline.__call__)`. The script already drops unknown kwargs and prints which ones it dropped. Also check the official repo's `infer_helios.py` (https://github.com/PKU-YuanGroup/Helios) for the exact V2V flags.
