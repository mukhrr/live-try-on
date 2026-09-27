# Pivot: Helios → JoyAI-Video-Edit (2026-09-25)

## Why
Helios V2V can't keep up with a live camera. Measured on a Modal H100, 640x384, car clip (99 frames):

| Setup | Time | FPS |
|---|---|---|
| SDPA, 2-2-2 steps | 16.1s | 6.1 |
| + FlashAttention 3 | 16.0s | 6.2 |
| + torch.compile | 11.3s | 8.8 |
| + compile, 1-1-1 steps | 7.8s | 12.8 |

Best steady state was 2.27s per 33-frame chunk against a 1.38s budget at 24 FPS, so live delay grows without bound. It also regenerates the scene (background, camera) rather than editing it.

## New primary candidate: JoyAI-Video-Edit (JD open source)
- Repo: https://github.com/jd-opensource/JoyAI-Video-Edit
- Weights: https://huggingface.co/jdopensource/JoyAI-Video-Edit
- **License: Apache 2.0**, commercial use OK. Verify the base model's license in the repo too.
- 16B autoregressive diffusion: MLLM condition encoder, causal video VAE, MMDiT.
- **Live camera stream input**, with causal chunk-by-chunk editing.
- **RV2V: reference-image-guided video editing.** It takes a garment image, which is what try-on needs. The Aug 14, 2026 checkpoint upgrade strengthened RV2V.
- Reported speed: **720p at 16 FPS on a single RTX PRO 6000 Blackwell (our card)**, 840×480 at 24 FPS on a 5090, up to 30 FPS at 720×1248 in the end-to-end configuration.
- Technique: chunk-causal with a sliding window plus a first-chunk sink, resampling forcing, and SA-DMD 2-step distillation (paper: arXiv 2608.03974).

## Status
Self-hosted on a Modal RTX PRO 6000 with `joyai_modal.py`, using JoyAI's own server and web UI (840x480 @ 24 FPS). Owner tested it live on 2026-09-25 and liked the result. Glass-to-glass latency is still unmeasured.

## Backups (all Apache 2.0, text-prompt only, no garment image)
- **StreamDiffusionV2**: Wan2.1 1.3B/14B, live-stream oriented, web demo in `demo/`. https://github.com/chenfengxu714/StreamDiffusionV2
- **LiveEdit** (ECCV 2026): Wan2.1 1.3B, Self-Forcing based, causal streaming edit, weights `cp-cp/LiveEdit`. https://github.com/cp-cp/LiveEdit
