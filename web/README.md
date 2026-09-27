# Web

Webcam page for the live pipeline. Sends camera frames over WebRTC to `server/`, shows what comes back, and overlays capture-to-display latency.

```bash
pnpm install
NEXT_PUBLIC_SERVER_URL=http://<gpu-box>:8000 pnpm dev   # defaults to http://localhost:8000
```

Open http://localhost:3000 on the machine with the camera. `getUserMedia` only works on localhost or https, so don't open it via a LAN IP.

Latency is measured with a 16-bit frame id painted into the top-left of each outgoing frame (the black and white bar you see on the output). The server copies it onto its output, the page reads it back and diffs against the send time. It includes encode, network, server, decode and render, but not camera capture.
