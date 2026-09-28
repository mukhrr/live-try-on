"""Local stand-in for the JoyAI server's /health and /ws protocol, so the extension can be tested without a GPU.

Echoes input frames back in 8-frame chunks after a simulated compute delay. MJPEG frames get a tint so they're
visibly "edited"; H.264 frames are echoed as-is.
  server/.venv/bin/python extension/dev/mock_joyai.py        # listens on :8765
"""
import asyncio
import io
import json
import os

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

CHUNK = 8
CHUNK_MS = float(os.environ.get("CHUNK_MS", "200"))

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "runtime_loaded": True}


def is_keyframe(annexb: bytes) -> bool:
    # IDR slice (NAL type 5) anywhere in the access unit.
    i = annexb.find(b"\x00\x00\x01")
    while i != -1:
        if i + 3 < len(annexb) and annexb[i + 3] & 0x1F == 5:
            return True
        i = annexb.find(b"\x00\x00\x01", i + 3)
    return False


def tint(jpeg: bytes) -> bytes:
    import av

    frame = next(av.open(io.BytesIO(jpeg), format="mjpeg").decode(video=0))
    img = frame.to_ndarray(format="rgb24").astype(np.float32)
    img[..., 0] = np.clip(img[..., 0] * 1.4, 0, 255)
    out = av.VideoFrame.from_ndarray(img.astype(np.uint8), format="rgb24")
    buf = io.BytesIO()
    container = av.open(buf, mode="w", format="mjpeg")
    stream = container.add_stream("mjpeg", rate=24)
    stream.width, stream.height, stream.pix_fmt = out.width, out.height, "yuvj420p"
    for packet in stream.encode(out.reformat(format="yuvj420p")):
        container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return buf.getvalue()


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({"type": "session_granted"})
    session_id = None
    h264 = False
    pending_meta = None
    frames_in = 0
    chunk: list[tuple[dict, bytes]] = []
    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("text") is not None:
                data = json.loads(msg["text"])
                kind = data.get("type")
                if kind == "start":
                    ref = data.get("ref_image") or ""
                    print(f"start: prompt={data.get('prompt')!r} ref_image={ref[:30]}… ({len(ref)} chars) "
                          f"codecs={data.get('input_codec')}/{data.get('output_codec')} size={data.get('width')}x{data.get('height')}", flush=True)
                    if not ref.startswith("data:image/"):
                        await websocket.send_json({"type": "error", "message": "ref_image missing"})
                        continue
                    session_id, frames_in, chunk = data.get("session_id"), 0, []
                    h264 = data.get("output_codec", "h264") == "h264"
                    await websocket.send_json({"type": "started", "session_id": session_id, "width": 840, "height": 480})
                elif kind == "frame_meta":
                    pending_meta = data
                elif kind == "ping":
                    await websocket.send_json({"type": "pong", "session_id": session_id, "t": data.get("t")})
                elif kind == "stop":
                    return
                continue

            if session_id is None:
                await websocket.send_json({"type": "error", "message": "send start JSON before frames"})
                continue
            frames_in += 1
            chunk.append((pending_meta or {"seq": frames_in, "t_capture_ms": 0}, msg["bytes"]))
            pending_meta = None
            await websocket.send_json({"type": "accepted", "session_id": session_id, "frames_in": frames_in})
            if len(chunk) < CHUNK:
                continue
            await asyncio.sleep(CHUNK_MS / 1000)
            await websocket.send_json({"type": "chunk_start", "session_id": session_id, "count": len(chunk)})
            for i, (meta, frame) in enumerate(chunk):
                await websocket.send_json({
                    "type": "output_frame", "session_id": session_id, "index": i, "count": len(chunk),
                    "source_seq": meta.get("seq"), "t_capture_ms": meta.get("t_capture_ms"),
                    "key": is_keyframe(frame) if h264 else True,
                })
                await websocket.send_bytes(frame if h264 else tint(frame))
            await websocket.send_json({"type": "chunk_done", "session_id": session_id, "count": len(chunk), "frames_in": frames_in})
            chunk = []
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
