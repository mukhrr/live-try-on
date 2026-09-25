# Helios V2V try-on bench

Tests Helios-Distilled (Apache 2.0) for live try-on on one GPU: clothing-swap quality and real end-to-end latency.

## Setup

Blackwell (RTX 6000 Pro) needs a CUDA 12.8+ PyTorch build.

```bash
conda create -n helios python=3.11 -y
conda activate helios
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
pip install git+https://github.com/huggingface/diffusers.git
pip install transformers accelerate imageio imageio-ffmpeg pillow numpy
```

First run downloads ~14B weights from Hugging Face.

## 1. Sanity check (do this first)

```bash
python helios_bench.py --sanity
```

Runs the official V2V car example. If `bench_out/sanity_v2v.mp4` looks broken, it's an install problem, not a model problem.

## 2. Record a test clip

About 10s, front-facing webcam, 24fps. Make it hard on purpose:
- Start still, facing the camera (the easy case)
- Raise and cross your arms (occlusion over the torso)
- Turn about 45° to each side (garment geometry)
- Lean closer to the camera (scale change)

```bash
# macOS
ffmpeg -f avfoundation -framerate 30 -i "0" -t 10 -r 24 me.mp4
# Linux
ffmpeg -f v4l2 -framerate 30 -i /dev/video0 -t 10 -r 24 me.mp4
```

Or record on your phone and copy it over.

## 3. Run

```bash
python helios_bench.py --video me.mp4 --person "A young man with short dark hair and a beard"
```

Useful flags:
- `--prompts prompts.json`: your own garments, as `[{"name": "...", "prompt": "{person}, wearing ..."}]`
- `--max-frames 264`: a longer clip (about 11s) to check drift
- `--video-noise-sigma-min / --video-noise-sigma-max`: the V2V knobs the Helios authors suggest tuning if output is off
- `--width 832 --height 480`: test a higher resolution

Output goes to `bench_out/`: side-by-side videos (input on the left, output on the right) and `results.md` / `results.json`.

## What to look at

**Latency** (`results.md`)
- Estimated live delay is the 33-frame buffer wait plus chunk compute, excluding network.
- Under about 0.5s feels live. 1–2s feels like a delayed mirror. Over 2s is probably unusable for try-on.
- "Keeps up with real time: NO" means it can't sustain a live stream at this resolution. That's a hard blocker.

**Quality** (watch every `*.mp4`, using `control.mp4` as the baseline)

| Check | Pass looks like |
|---|---|
| Garment | Matches the prompt: color, material, cut |
| Identity | Your face is still clearly you, with no morphing |
| Background | Room unchanged; only the clothes change |
| Chunk seams | No visible jump or flicker every 33 frames (~1.4s) |
| Occlusion | Arms crossing the torso don't break the garment |
| Drift | Frame 250 looks as good as frame 30 |

## Decision

- **Latency OK and quality OK:** move to the live WebRTC pipeline with Helios.
- **Quality OK but latency too high:** try frame-wise models (Causal Forcing, CausVid) next.
- **Latency OK but garment or identity weak:** this is the case for fine-tuning with garment-image conditioning.
- **Both bad:** reassess. Maybe offline try-on first, or the Lucy API for the live part.
