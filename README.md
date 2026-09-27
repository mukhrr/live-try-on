# Toshoyna: live video try-on

Webcam in, the same person wearing a chosen garment out, live. The first product is a Chrome extension: pick a product on a shop page and a mirror window shows you wearing it.

The model is [JoyAI-Video-Edit](https://github.com/jd-opensource/JoyAI-Video-Edit) (Apache 2.0), which streams video edits and takes the garment as a reference image.

## Run the model server (Modal, RTX PRO 6000)

```bash
python -m venv .venv && .venv/bin/pip install modal
.venv/bin/modal setup                         # once, browser login
.venv/bin/python joyai_modal.py download      # once, ~51GB of weights into a Modal volume, CPU only
.venv/bin/modal serve joyai_modal.py          # prints a URL; Ctrl-C stops it
```

Open the URL, allow the camera, add a garment image and an instruction such as `Put the jacket from Image 1 on the model in the video`.

- Runs at 840x480, 24 FPS. About $3/hour while a container is up; it shuts down after 5 idle minutes.
- A cold start compiles for about 25 minutes. After that the compile cache on the `joyai-compile-cache` volume brings it down to about 2 minutes.
- `joyai_patches.py` lengthens two warmup timeouts in JoyAI that assume a warm compile cache.

## Other parts

- `server/` and `web/`: our own WebRTC webcam pipeline with a capture-to-display latency overlay. See their READMEs.
- `docs/`: research notes, the plan, and the pivot from Helios to JoyAI.
