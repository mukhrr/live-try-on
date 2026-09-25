# Research notes: real-time video try-on (2026-09-25)

## 1. Decart Lucy (the reference product)
- A real-time video editing model. It transforms a live feed (people, garments, objects, backgrounds, VFX) from text prompts and/or a reference image.
- **Lucy 2.0** (Jan 26, 2026): 1080p at 30fps live, no time limit, about $3/hr to run.
- **Lucy 2.5** (Jul 16, 2026): better edits, physics-aware VFX, better temporal consistency, lower latency. Uses "Self-Anchoring": a few seconds in, it grabs its own output as a reference frame to lock identity.
- The API docs say **720p** realtime (press coverage says 1080p). There's a dedicated **virtual try-on model**. TS/Python/Android SDK (`@decartai/sdk`), WebRTC-style: `client.realtime.connect(stream)` then `set({prompt, image})`. Billed per second; third-party figures are about $0.02/s realtime and $0.04/s rendered (unverified).
- Company: Israeli. Raised $300M in May 2026 (led by Radical Ventures; also Sequoia, Benchmark).

## 2. How it's built (from Decart's MirageLSD tech report, July 2025, and the open literature)
1. **Autoregressive, frame-by-frame diffusion** (Live Stream Diffusion). Each frame is conditioned on recent frames, the current input frame, and the prompt. Causal attention allows KV caching the way LLMs do.
2. **Anti-drift training.** *Diffusion forcing* (independent noise per frame) and *history augmentation* (training on corrupted history so the model learns to correct itself). Without this, quality dies after 20–30s.
3. **Few-step distillation.** *Shortcut distillation* (open equivalent: DMD / distribution matching distillation) brings 20–50 steps down to about 1–4.
4. **GPU engineering.** Custom CUDA megakernels for Hopper, architecture-aware pruning, over 100x efficiency gains. This is their moat.
5. Their open offline editor, **Lucy Edit Dev** (~5B, on Wan2.2 5B, **non-commercial**), suggests the live model is a causal, distilled version of a similar editor.

## 3. Open research doing the same thing
- **Self-Forcing** (NeurIPS 2025): simulates inference during training; streams in real time on one RTX 4090.
- **CausVid** (CVPR 2025): distills Wan 1.3B into a 4-step causal model, 9.4 FPS, zero-shot streaming V2V. https://github.com/tianweiy/CausVid
- **Causal Forcing** (ICML 2026): fixes a theoretical flaw in Self-Forcing. Weights at `zhuhz22/Causal-Forcing`, real-time on a 4090.
- **Rolling Forcing**: open Wan2.1 base, about 3k training steps, no video data needed.
- **LongLive** (NVIDIA, ICLR 2026): 1.3B, 20.7 FPS on an H100, prompt switching mid-stream. T2V, so not suited to editing a live feed.
- **JoyAI-Video-Edit** (Aug 2026): a 16B real-time editor. Chunk-causal, sliding window plus first-chunk sink, 2-step distillation. The closest public blueprint to Lucy. Weights not verified.
- **LiveVVT** (arXiv 2608.26714, Aug 27 2026): **real-time streaming video try-on**. Rolling window, bounded temporal memory, plus a *persistent garment appearance memory* built from the garment image and one frontal try-on keyframe. 26x lower latency than baselines. **No code/weights found yet.** Worth emailing the authors.

## 4. Model shortlist

### Real-time / streaming (text-prompt driven, not garment-image faithful)
| Model | Size | Speed (reported) | License | Notes |
|---|---|---|---|---|
| **Helios-Distilled** | 14B | 19.5 FPS on 1× H100 | **Apache 2.0** | T2V/I2V/V2V, Diffusers, 33-frame chunks. **Chosen first.** |
| LongLive | 1.3B | 20.7 FPS on H100 | check | T2V only |
| Causal Forcing | Wan2.1-based | real-time on 4090 | check | frame-wise; best training base |
| CausVid | 1.3B | 9.4 FPS | check | streaming V2V |
| Krea Realtime | 14B | ~11 FPS on B200 | **non-commercial** | skip |

### Garment-faithful try-on (offline, uses the garment image)
- **MagicTryOn**: video try-on on Wan2.1, full self-attention, offline. Weights: `LuckyLiGY/MagicTryOn`. License unverified.
- **FLUX.2 [klein] 9B try-on LoRA** (fal, open weights): person plus top/bottom garment images give one image. Good for setting the quality bar and for making keyframes.
- **CatVTON-FLUX**: image try-on LoRA on FLUX fill; state of the art on VITON-HD at release.

## 5. Sources
- https://decart.ai/lucy
- https://docs.platform.decart.ai/models/realtime/lucy-2.5
- https://about.decart.ai/publications/mirage?amp=
- https://the-decoder.com/decart-launches-miragelsd-an-ai-model-that-transforms-live-video-feeds-in-real-time/
- https://huggingface.co/decart-ai/Lucy-Edit-Dev
- https://www.forbes.com/sites/charliefink/2026/01/27/decarts-new-lucy-2-generative-ai-video-model-pushes-generative-video-into-real-time/
- https://thenextweb.com/news/decart-lucy-2-5-live-video-effects-physical-ai
- https://arxiv.org/abs/2608.26714 (LiveVVT)
- https://arxiv.org/pdf/2608.03974 (JoyAI-Video-Edit)
- https://arxiv.org/abs/2602.02214 (Causal Forcing)
- https://arxiv.org/pdf/2509.25161 (Rolling Forcing)
- https://self-forcing.github.io/
- https://github.com/tianweiy/CausVid
- https://huggingface.co/BestWishYsh/Helios-Distilled
- https://github.com/PKU-YuanGroup/Helios
- https://huggingface.co/LuckyLiGY/MagicTryOn
- https://github.com/backblaze-labs/awesome-video-generation
- https://github.com/Zheng-Chong/Awesome-Try-On-Models
