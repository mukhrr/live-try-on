#!/usr/bin/env python3
"""JoyAI-Video-Edit live server on a Modal RTX PRO 6000, using the authors' own server and web UI.

  python joyai_modal.py download        # once: ~51GB of weights into a volume, CPU only
  modal serve joyai_modal.py            # prints a URL; open it, allow the webcam. Ctrl-C stops billing.
  JOYAI_REGION=eu modal serve ...       # pin the GPU nearer the viewer; Modal charges 1.5x for "eu"

The server has no login, so its URL is the only thing keeping strangers off the GPU. The URL's label is random
and lives in the git-ignored .joyai-label (created on first run), never in the repo.

Follows DEPLOYMENT.md's "RTX PRO 6000, 480p @ 24 FPS" setup: cuDNN attention (no SageAttention/FA4),
FP8 via joyomni_ops built for sm_120a. The optional face/person ONNX gates are left out on purpose:
the YOLOv8 export is AGPL, and the server runs edits unconditionally without them.
"""
import os
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

import modal

JOYAI_REPO = "https://github.com/jd-opensource/JoyAI-Video-Edit.git"
JOYAI_SHA = "ca17e1d1030f454cb98b0ed549b4d31a60139ceb"
CUTLASS_SHA = "dcf215af"  # pinned in DEPLOYMENT.md
DEPLOY = "/opt/joyai/deploy"
PORT = 8080
REGION = os.environ.get("JOYAI_REGION") or None


def _label() -> str:
    path = Path(__file__).parent / ".joyai-label"
    if not path.exists():
        path.write_text(f"toshoyna-{secrets.token_hex(6)}\n")
    return path.read_text().strip()


LABEL = os.environ.get("JOYAI_LABEL") or _label()

app = modal.App("live-try-on-joyai")
weights = modal.Volume.from_name("joyai-weights", create_if_missing=True)
cache = modal.Volume.from_name("joyai-compile-cache", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04", add_python="3.10")
    .apt_install("git", "curl", "build-essential")
    .run_commands(
        f"git clone {JOYAI_REPO} /opt/joyai && git -C /opt/joyai checkout {JOYAI_SHA}",
        f"python -m pip install -r {DEPLOY}/requirements.txt",
    )
    # Build for the RTX PRO 6000 only; the default 5-arch fat binary takes ~5x longer and needs no GPU either way.
    .run_commands(
        "python -m pip install --upgrade setuptools wheel",
        f"git clone https://github.com/NVIDIA/cutlass.git /opt/cutlass && git -C /opt/cutlass checkout {CUTLASS_SHA}",
        # Modal's bundled Python was built with clang, so extension builds default to clang++; the image has gcc.
        f"CC=gcc CXX=g++ JOYOMNI_OPS_CUDA_ARCHS=120a JOYOMNI_OPS_CUTLASS_DIR=/opt/cutlass TORCH_CUDA_ARCH_LIST=12.0 MAX_JOBS=8 "
        f"python -m pip install --no-build-isolation {DEPLOY}/joyomni_ops",
    )
    .add_local_file(Path(__file__).parent / "joyai_patches.py", "/opt/joyai_patches.py", copy=True)
    .run_commands("python /opt/joyai_patches.py")
)


@app.function(image=image, volumes={"/weights": weights}, timeout=2 * 60 * 60)
def download():
    from huggingface_hub import snapshot_download

    snapshot_download(
        "jdopensource/JoyAI-Video-Edit",
        local_dir="/weights/JoyAI-Video-Edit",
        allow_patterns=["dit/joyai_video_edit_dit_0811.pth", "vae/*"],
    )
    snapshot_download("XiaomiMiMo/MiMo-VL-7B-RL-2508", local_dir="/weights/MiMo-VL-7B-RL-2508")
    weights.commit()
    return subprocess.run(["du", "-sh", "/weights"], capture_output=True, text=True).stdout


def _commit_cache_periodically():
    # Warmup compiles into /cache for ~15 min on a cold start; persist as it goes so a crash doesn't lose it.
    while True:
        time.sleep(120)
        try:
            cache.commit()
        except Exception as e:
            print(f"cache commit failed: {e!r}", flush=True)


def _exit_with(proc: subprocess.Popen):
    # Without this a crashed server leaves the container (and the GPU bill) idling until scaledown.
    code = proc.wait()
    print(f"JoyAI server exited with {code}, stopping container", flush=True)
    try:
        cache.commit()
    finally:
        os._exit(1)


@app.function(
    image=image,
    gpu="RTX-PRO-6000",
    region=REGION,
    volumes={"/weights": weights, "/cache": cache},
    timeout=60 * 60,
    scaledown_window=5 * 60,
    max_containers=1,
)
@modal.concurrent(max_inputs=50)
@modal.web_server(PORT, startup_timeout=40 * 60, label=LABEL)
def serve():
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/local/cuda/bin",
        "JOYOMNI_CKPT_ROOT": "/weights",
        "JOYOMNI_CACHE_ROOT": "/cache/pro6000",
        "JOYOMNI_RECORD_DIR": "/tmp/recordings",
        "JOYOMNI_HOST": "0.0.0.0",
        "JOYOMNI_PORT": str(PORT),
    }
    proc = subprocess.Popen(["bash", f"{DEPLOY}/run_server.sh"], env=env)
    threading.Thread(target=_commit_cache_periodically, daemon=True).start()
    threading.Thread(target=_exit_with, args=(proc,), daemon=True).start()


if __name__ == "__main__":
    if sys.argv[1:] != ["download"]:
        raise SystemExit("usage: python joyai_modal.py download   (then: modal serve joyai_modal.py)")
    with modal.enable_output(), app.run(detach=True):
        print(download.remote())
