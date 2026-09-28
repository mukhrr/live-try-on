# Toshoyna (live-try-on): project context for Claude

Read this first. Background research is in `docs/research.md`, the Helios-to-JoyAI pivot with benchmark numbers in `docs/pivot-joyai.md`, phases in `docs/plan.md`.

## Goal
A **real-time video virtual try-on**: live webcam in, the same person wearing a chosen garment out, like Decart's Lucy 2.5 (closed, paid) but self-hosted. Commercial use is intended, so **licenses matter**.

**Product: Toshoyna, a Chrome extension** (toshoyna.ai; "tosh oyna", the historical word for mirror). On any shop page the user clicks the toolbar icon, then a product photo, and a **floating mirror appears in the page corner** showing their webcam with them wearing that product. Expand opens a full-screen mirror of the same stream. The product photo is the model's reference image.

## How it works
- **Model: JoyAI-Video-Edit** (`jd-opensource/JoyAI-Video-Edit`, Apache 2.0 code and weights, 16B). Streaming video-to-video editing that takes the garment as a reference image ("Put the hoodie from Image 1 on the model in the video"). It edits in 8-frame chunks.
- **GPU: Modal, RTX PRO 6000 (96GB), US only.** `joyai_modal.py` runs JoyAI's own server (FastAPI + websocket `/ws`) at 840x480 or 480x840, 24 FPS. Weights live on volume `joyai-weights` (~51GB), the torch.compile cache on `joyai-compile-cache`. Cold start ~25 min (compile), warm ~2 min; containers stop after 5 idle minutes. `joyai_patches.py` lengthens two warmup timeouts that assume a warm cache. The server allows one session at a time.
- **Extension (`extension/`)**, TypeScript + React + Tailwind, Vite, Manifest V3:
  - `src/content.ts`: pick mode (highlight images, click to pick), picks the sharpest image the page offers, then injects the floating mirror iframe. Must stay import-free (injected as a classic script).
  - `src/engine/`: runs in an **offscreen document**. Camera, JoyAI websocket client (`mirror/joyai.ts`), H.264 uplink encoder. The float never touches the camera, so shops can't block it and Chrome doesn't prompt per site.
  - `src/viewer/`: the mirror UI, used by `float.html` (iframe on the shop page) and `mirror.html` (full-screen window). Each viewer decodes and paces the H.264 downlink itself (`mirror/codec.ts`, `mirror/playback.ts`).
  - `src/bus.ts`: the BroadcastChannel protocol between engine and viewers. Viewers send product, size and settings; the engine closes itself 15s after the last viewer leaves.
  - `src/mirror/garment.ts`: names the garment in the instruction from the product text (English, Russian, Uzbek; "костюм"/"kostyum" maps to "outfit", not "suit").
  - `dev/mock_joyai.py`: speaks the same websocket protocol and echoes frames, for GPU-free testing.
- `server/` and `web/` are the earlier WebRTC skeleton (aiortc + Next.js, pixel-marker latency overlay). Not used by the extension; kept for reference.

## Measured (2026-09-27/28)
- Real delay, owner's webcam in Tashkent to Modal US: **~0.9-1.3s capture-to-display**, ping ~450ms, ~0.7 Mbit/s each way, 21-24 fps. Try-on quality: owner says it looks good.
- Where the time goes: 0.33s waiting for an 8-frame chunk + 0.27s compute + ~0.45s network + ~0.25s transfer, decode and paced playback. JoyAI's floor on this GPU is ~0.7-0.8s even with a perfect network.
- JPEG frames were ~8-10 Mbit/s each way and queued up on a home uplink; H.264 configured like JoyAI's own client fixed that.
- `JOYAI_REGION=eu`: Modal never scheduled an RTX PRO 6000 in the EU (pending 1h40m, no cost). US only for now.
- Helios-Distilled (the first candidate) was too slow: best 2.27s per 33-frame chunk against a 1.38s budget on an H100. Removed.

## Hardware
- **GPU:** not owned (buying an RTX PRO 6000 is ~$14-16k as of 2026-09). Rented per second on Modal, ~$3/hour while a container runs, from the $30/month credit plus a card on file. Blackwell needs **PyTorch for CUDA 12.8+**.
- **MacBook (Apple Silicon):** code, extension, testing. Models don't run here.
- Repo: github.com/mukhrr/live-try-on (private). Active branch `joyai-live`, not yet merged into `main`.

## Owner preferences
- Direct, casual communication. No filler.
- **Validate assumptions before writing code.** Measure first, then build.
- Frontend: TypeScript, React, Tailwind. ML backend: Python.

## Releases
- **Bump the extension version on every release** (owner, 2026-09-28): `cd extension && pnpm release [patch|minor|major]` bumps `package.json`, builds, commits and tags `extension-vX.Y.Z`; then `git push --follow-tags`. `package.json` is the only place the version lives (the build writes it into the manifest), and the mirror header shows it.
- A release is any build handed to the owner to reload. Patch for fixes, minor for features. Current: **v0.4.0** (floating mirror).
- Test before handing over: build, then the Playwright end-to-end run against `dev/mock_joyai.py` (Chromium with `--load-extension` and a fake camera). Real-GPU checks cost Modal time; say so first.

## Key decisions
1. **Don't train from scratch.** Bake-off first; fine-tune or distill only if a measured gap is worth it.
2. **JoyAI-Video-Edit** over Helios (too slow) and over text-only live models (no garment photo). Low-latency fallback if ever needed: StreamDiffusionV2 1.3B (Apache 2.0, text only).
3. **Keep JoyAI at ~1s delay and polish the extension** (owner, 2026-09-28) rather than chase latency now. Later options: a European GPU host outside Modal (RunPod/Vast) for ~0.2-0.3s, a B200 at 30 FPS for ~0.15-0.2s, or a frame-wise model for sub-0.5s (research, weaker garment fidelity).
4. **Licenses:** avoid Krea Realtime 14B, Lucy Edit Dev, CausVid, Rolling Forcing (non-commercial). JoyAI's optional YOLOv8 person gate is AGPL, so it's left out. Verify MagicTryOn's license before using it.

## Open items
- The dev server URL comes from `modal serve` and only works while that command runs. A real release needs `modal deploy` for a stable URL, and a way to handle the ~2 min wake-up.
- One session per GPU: a second user is queued, and JoyAI's server drops queued clients after about a minute. Real users need a queue or more containers.
- The first-run camera permission page (`permission.html`) is untested with a real Chrome prompt; tests auto-grant the camera.
- The float isn't draggable and disappears when the page navigates.
- Chrome Web Store: `<all_urls>` host permission (needed to fetch product photos from any shop) will need a justification.
- `server/` + `web/` skeleton: decide whether to delete it.
