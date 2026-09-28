# Toshoyna: live video try-on

A Chrome extension: click a product photo on any shop page, and a floating mirror in the corner shows you wearing it, live from your webcam. Expand it to full screen for a bigger mirror.

The try-on model is [JoyAI-Video-Edit](https://github.com/jd-opensource/JoyAI-Video-Edit) (Apache 2.0). It streams video edits and takes the product photo as the garment reference. It runs on a rented RTX PRO 6000 on [Modal](https://modal.com). Expect roughly 1 second of delay.

## 1. Start the model server (Modal)

```bash
python -m venv .venv && .venv/bin/pip install modal
.venv/bin/modal setup                         # once, browser login
.venv/bin/python joyai_modal.py download      # once, ~51GB of weights into a Modal volume, CPU only
.venv/bin/modal serve joyai_modal.py          # prints the server URL; Ctrl-C stops it
```

- About $3/hour while a GPU container is up. It shuts down after 5 idle minutes and wakes on the next request (~2 minutes, or ~25 on the very first start while it compiles).
- The server URL also serves JoyAI's own test page: open it, allow the camera, add a garment photo.

## 2. Build and load the extension

```bash
cd extension
pnpm install
pnpm build
```

In Chrome: `chrome://extensions`, turn on Developer mode, **Load unpacked**, pick `extension/dist`. Pin the Toshoyna icon.

Then on a shop page: click the icon, click a product photo. The mirror header in full-screen mode shows the loaded version.

Releases: `pnpm release [patch|minor|major]` bumps the version, builds, commits and tags; then `git push --follow-tags`.

## 3. Test without a GPU

```bash
server/.venv/bin/python extension/dev/mock_joyai.py    # http://127.0.0.1:8765
```

Set the server to `http://127.0.0.1:8765` under ⚙ in the full-screen mirror. The mock speaks JoyAI's websocket protocol and echoes your frames back.

## Layout

| Path | What |
|---|---|
| `extension/` | The Chrome extension. See its README for how the engine and viewers are split |
| `joyai_modal.py`, `joyai_patches.py` | JoyAI server on Modal |
| `server/`, `web/` | Earlier WebRTC webcam skeleton with a latency overlay; not used by the extension |
| `docs/` | Research, plan, and the pivot from Helios to JoyAI with benchmark numbers |
