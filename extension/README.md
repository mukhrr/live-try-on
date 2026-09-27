# Toshoyna Chrome extension

Click the toolbar icon on a shop page, click a product photo, and a mirror window shows your webcam with you wearing it. The mirror streams to the JoyAI server (see the root README) with the product photo as the reference image.

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

Then set the mirror's server to `http://127.0.0.1:8765`.

The badge in the top right is capture-to-display latency: the server echoes each frame's capture time back with the edited frame.
