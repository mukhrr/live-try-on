# Toshoyna Chrome extension

Click the toolbar icon on a shop page, click a product photo, and a floating mirror appears in the corner of the page showing you wearing it. Its expand button opens a full-screen mirror of the same stream.

How it's split:
- `src/engine/` runs in an offscreen document: camera, the JoyAI websocket (see the root README) and the H.264 encoder. The product photo is JoyAI's reference image.
- `src/viewer/` is the mirror UI, used by both `float.html` (an iframe on the shop page) and `mirror.html` (the full-screen window). Each viewer decodes the engine's stream itself, so expanding doesn't restart the session. They talk over a BroadcastChannel (`src/bus.ts`).
- The float never touches the camera, so shops can't block it and Chrome doesn't ask per site. The first time, `permission.html` asks for camera access once for the extension.
- The engine closes itself 15s after the last viewer goes away.

```bash
pnpm install
pnpm build            # or `pnpm dev` to rebuild on change
```

Load it in Chrome: `chrome://extensions`, turn on Developer mode, **Load unpacked**, pick `extension/dist`.

The server URL defaults to the `modal serve` dev URL. Change it with **Server** at the bottom of the mirror, or build with `VITE_SERVER_URL=https://... pnpm build`. The first open after a break waits about 2 minutes while Modal starts the GPU container.

## Testing without a GPU

`dev/mock_joyai.py` speaks the same websocket protocol and echoes your frames back tinted, in 8-frame chunks:

```bash
../server/.venv/bin/python dev/mock_joyai.py     # http://127.0.0.1:8765
```

Then set the server to `http://127.0.0.1:8765` under ⚙ in the full-screen mirror.

The badge in the top right is capture-to-display latency: the server echoes each frame's capture time back with the edited frame.
