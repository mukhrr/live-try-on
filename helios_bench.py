#!/usr/bin/env python3
"""
Helios-Distilled V2V try-on bench.

Answers two questions on your own GPU:
  1. Quality  - does V2V swap clothing while keeping face/body/background?
  2. Latency  - what would live end-to-end delay be, not just throughput FPS?

Usage:
  python helios_bench.py --sanity                       # verify install with the official example
  python helios_bench.py --video me.mp4 --person "A young man with short dark hair and a beard"
  python helios_bench.py --video me.mp4 --person "..." --prompts prompts.json --latency-runs 10
"""
import argparse
import inspect
import json
import statistics
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from diffusers import AutoModel, HeliosPyramidPipeline
from diffusers.utils import export_to_video, load_video

MODEL_ID = "BestWishYsh/Helios-Distilled"
CHUNK = 33  # Helios generates 33 frames per autoregressive chunk

NEGATIVE = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, "
    "static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, "
    "extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, "
    "fused fingers, still picture, messy background, three legs, many people in the background, "
    "walking backwards"
)

SCENE = "facing a front-facing webcam in a room, natural indoor lighting, realistic, sharp details"

# "control" keeps the original clothes: its drift is the baseline to compare the swaps against.
DEFAULT_PROMPTS = [
    {"name": "control", "prompt": "{person}, wearing the same clothes as in the original video, " + SCENE},
    {"name": "red_denim", "prompt": "{person}, wearing a red denim jacket over a plain white t-shirt, " + SCENE},
    {"name": "leather", "prompt": "{person}, wearing a black leather biker jacket with silver zippers, " + SCENE},
    {"name": "suit", "prompt": "{person}, wearing a navy blue business suit with a white shirt and a dark tie, " + SCENE},
    {"name": "raincoat", "prompt": "{person}, wearing a bright yellow hooded raincoat, " + SCENE},
]

SANITY_VIDEO = "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/diffusers/helios/car.mp4"
SANITY_PROMPT = (
    "A bright yellow Lamborghini speeds along a curving mountain road, surrounded by lush green trees "
    "under a partly cloudy sky. A front-facing shot from a slightly elevated angle."
)


# ---------- helpers ----------

def round_to_chunk(n: int) -> int:
    return max(CHUNK, (n // CHUNK) * CHUNK)


def prep_frames(src: str, width: int, height: int, max_frames: int) -> list:
    """Load video, center-crop to target aspect, resize, trim to a multiple of 33 frames."""
    frames = load_video(src)
    target = width / height
    out = []
    for f in frames:
        f = f.convert("RGB")
        sw, sh = f.size
        if sw / sh > target:
            nw = int(sh * target)
            left = (sw - nw) // 2
            f = f.crop((left, 0, left + nw, sh))
        else:
            nh = int(sw / target)
            top = (sh - nh) // 2
            f = f.crop((0, top, sw, top + nh))
        out.append(f.resize((width, height), Image.BICUBIC))
    n = min(round_to_chunk(max_frames), (len(out) // CHUNK) * CHUNK)
    if n < CHUNK:
        raise SystemExit(f"Video has {len(out)} frames; need at least {CHUNK}.")
    return out[:n]


def to_np(f) -> np.ndarray:
    if isinstance(f, Image.Image):
        return np.asarray(f.convert("RGB"))
    a = np.asarray(f)
    if a.dtype != np.uint8:
        a = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    return a


def side_by_side(inp: list, out: list) -> list:
    n = min(len(inp), len(out))
    res = []
    for i in range(n):
        a = to_np(inp[i])
        b = to_np(out[i])
        if b.shape[:2] != a.shape[:2]:
            b = np.asarray(Image.fromarray(b).resize((a.shape[1], a.shape[0]), Image.BICUBIC))
        res.append(np.concatenate([a, b], axis=1))
    return res


def load_pipe():
    vae = AutoModel.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    pipe = HeliosPyramidPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=torch.bfloat16)
    pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    return pipe


def build_kwargs(pipe, frames, prompt, seed, width, height, extra):
    accepted = set(inspect.signature(pipe.__call__).parameters)
    kw = dict(
        prompt=prompt,
        negative_prompt=NEGATIVE,
        video=frames,
        num_frames=len(frames),
        pyramid_num_inference_steps_list=[2, 2, 2],
        guidance_scale=1.0,
        is_amplify_first_chunk=True,
        generator=torch.Generator("cuda").manual_seed(seed),
        height=height,
        width=width,
        **extra,
    )
    dropped = [k for k in kw if k not in accepted]
    for k in dropped:
        kw.pop(k)
    return kw, dropped


def run(pipe, frames, prompt, seed, width, height, extra):
    kw, dropped = build_kwargs(pipe, frames, prompt, seed, width, height, extra)
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    out = pipe(**kw).frames[0]
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    vram = torch.cuda.max_memory_allocated() / 1024**3
    return out, dt, vram, dropped


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="Input clip (webcam recording). Front-facing, ~10s.")
    ap.add_argument("--person", default="A person", help="Short description of you, used in every prompt.")
    ap.add_argument("--prompts", help="JSON file: [{name, prompt}] with optional {person} placeholder.")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=384)
    ap.add_argument("--max-frames", type=int, default=132, help="Rounded down to a multiple of 33.")
    ap.add_argument("--input-fps", type=float, default=24.0, help="Camera FPS, used for buffer latency.")
    ap.add_argument("--latency-runs", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--video-noise-sigma-min", type=float)
    ap.add_argument("--video-noise-sigma-max", type=float)
    ap.add_argument("--out", default="bench_out")
    ap.add_argument("--sanity", action="store_true", help="Run the official V2V example only.")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    extra = {}
    if args.video_noise_sigma_min is not None:
        extra["video_noise_sigma_min"] = args.video_noise_sigma_min
    if args.video_noise_sigma_max is not None:
        extra["video_noise_sigma_max"] = args.video_noise_sigma_max

    gpu = torch.cuda.get_device_name(0)
    print(f"GPU: {gpu} | torch {torch.__version__} | CUDA {torch.version.cuda}")
    print("Loading Helios-Distilled...")
    pipe = load_pipe()

    if args.sanity:
        frames = prep_frames(SANITY_VIDEO, args.width, args.height, 99)
        out, dt, vram, dropped = run(pipe, frames, SANITY_PROMPT, args.seed, args.width, args.height, extra)
        export_to_video(side_by_side(frames, out), str(out_dir / "sanity_v2v.mp4"), fps=24)
        print(f"Sanity OK: {len(frames)} frames in {dt:.2f}s ({len(frames)/dt:.1f} FPS), peak VRAM {vram:.1f} GB")
        if dropped:
            print(f"Note: pipeline ignored args {dropped}")
        print(f"Compare {out_dir/'sanity_v2v.mp4'} against the official V2V sanity-check video.")
        return

    if not args.video:
        raise SystemExit("--video is required (or use --sanity).")

    prompts = DEFAULT_PROMPTS
    if args.prompts:
        prompts = json.loads(Path(args.prompts).read_text())
    for p in prompts:
        p["prompt"] = p["prompt"].replace("{person}", args.person)

    frames = prep_frames(args.video, args.width, args.height, args.max_frames)
    print(f"Input: {len(frames)} frames at {args.width}x{args.height}")

    # Warmup (first call includes kernel selection / allocation)
    print("Warmup...")
    _, _, _, dropped = run(pipe, frames[:CHUNK], prompts[0]["prompt"], args.seed, args.width, args.height, extra)
    if dropped:
        print(f"Note: pipeline does not accept {dropped}; those args are ignored.")

    # ---- 1. Latency: single-chunk compute time ----
    print(f"Latency: {args.latency_runs} single-chunk runs...")
    chunk_times, chunk_vram = [], []
    for i in range(args.latency_runs):
        _, dt, vram, _ = run(pipe, frames[:CHUNK], prompts[0]["prompt"], args.seed + i,
                             args.width, args.height, extra)
        chunk_times.append(dt)
        chunk_vram.append(vram)
    chunk_med = statistics.median(chunk_times)
    chunk_p95 = sorted(chunk_times)[max(0, int(round(0.95 * len(chunk_times))) - 1)]
    buffer_s = CHUNK / args.input_fps
    budget_s = CHUNK / args.input_fps  # must generate a chunk before the next one is buffered
    latency = {
        "chunk_frames": CHUNK,
        "chunk_compute_median_s": round(chunk_med, 3),
        "chunk_compute_p95_s": round(chunk_p95, 3),
        "buffer_wait_s": round(buffer_s, 3),
        "est_live_latency_s": round(buffer_s + chunk_med, 3),
        "est_live_latency_p95_s": round(buffer_s + chunk_p95, 3),
        "keeps_up_realtime": chunk_med < budget_s,
        "sustainable_fps": round(CHUNK / chunk_med, 1),
        "peak_vram_gb": round(max(chunk_vram), 1),
        "note": "Excludes capture, encode and network time. Add ~50-150ms for a WebRTC round trip.",
    }

    # ---- 2. Quality: full clip per prompt ----
    quality = []
    for p in prompts:
        print(f"Quality: {p['name']}...")
        out, dt, vram, _ = run(pipe, frames, p["prompt"], args.seed, args.width, args.height, extra)
        name = f"{p['name']}.mp4"
        export_to_video(side_by_side(frames, out), str(out_dir / name), fps=int(args.input_fps))
        quality.append({
            "name": p["name"],
            "prompt": p["prompt"],
            "frames": len(out),
            "time_s": round(dt, 2),
            "throughput_fps": round(len(out) / dt, 1),
            "peak_vram_gb": round(vram, 1),
            "file": name,
        })

    results = {
        "gpu": gpu,
        "torch": torch.__version__,
        "resolution": f"{args.width}x{args.height}",
        "extra_args": extra,
        "latency": latency,
        "quality": quality,
    }
    (out_dir / "results.json").write_text(json.dumps(results, indent=2))

    md = [
        f"# Helios-Distilled V2V bench — {gpu}",
        "",
        f"Resolution {args.width}x{args.height}, input {args.input_fps:g} fps",
        "",
        "## Latency (live estimate)",
        "",
        f"- Chunk compute: median **{chunk_med:.2f}s**, p95 {chunk_p95:.2f}s",
        f"- Buffer wait (33 frames): {buffer_s:.2f}s",
        f"- **Estimated live delay: {buffer_s + chunk_med:.2f}s** (p95 {buffer_s + chunk_p95:.2f}s) + network",
        f"- Keeps up with real time: **{'yes' if latency['keeps_up_realtime'] else 'NO'}** "
        f"(sustainable {latency['sustainable_fps']} fps vs {args.input_fps:g} needed)",
        f"- Peak VRAM: {latency['peak_vram_gb']} GB",
        "",
        "## Quality runs (left = input, right = output)",
        "",
        "| Prompt | Frames | Time | Throughput | VRAM | File |",
        "|---|---|---|---|---|---|",
    ]
    for q in quality:
        md.append(f"| {q['name']} | {q['frames']} | {q['time_s']}s | {q['throughput_fps']} fps | "
                  f"{q['peak_vram_gb']} GB | {q['file']} |")
    (out_dir / "results.md").write_text("\n".join(md) + "\n")

    print("\n".join(md))
    print(f"\nSaved to {out_dir}/")


if __name__ == "__main__":
    main()
