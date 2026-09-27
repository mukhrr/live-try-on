import asyncio
import json
import logging
import os
import time
from pathlib import Path

from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from av import VideoFrame
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import marker
import processors

log = logging.getLogger("tryon")
logging.basicConfig(level=logging.INFO)

PROCESSOR = os.environ.get("PROCESSOR", "passthrough")
SIMULATE_MS = float(os.environ.get("SIMULATE_MS", "0"))
GARMENTS = Path(os.environ.get("GARMENTS", Path(__file__).parent / "garments.json"))

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
peers: set[RTCPeerConnection] = set()


class Stats:
    def __init__(self):
        self.reset()

    def reset(self):
        self.frames = 0
        self.dropped = 0
        self.process_ms = 0.0

    def snapshot(self) -> dict:
        snap = {
            "type": "stats",
            "fps_out": self.frames,
            "dropped": self.dropped,
            "process_ms": round(self.process_ms / self.frames, 1) if self.frames else None,
        }
        self.reset()
        return snap


class ProcessedTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, source: MediaStreamTrack, processor: processors.FrameProcessor, stats: Stats):
        super().__init__()
        self.source = source
        self.processor = processor
        self.stats = stats
        self._latest: VideoFrame | None = None
        self._ready = asyncio.Event()
        self._ended = False
        self._reader = asyncio.ensure_future(self._read())

    async def _read(self):
        # Keep only the newest frame so a slow processor drops frames instead of building a queue.
        try:
            while True:
                frame = await self.source.recv()
                if self._latest is not None:
                    self.stats.dropped += 1
                self._latest = frame
                self._ready.set()
        except MediaStreamError:
            self._ended = True
            self._ready.set()

    async def recv(self) -> VideoFrame:
        await self._ready.wait()
        self._ready.clear()
        if self._ended:
            self.stop()
            raise MediaStreamError
        frame, self._latest = self._latest, None

        t0 = time.perf_counter()
        img = frame.to_ndarray(format="rgb24")
        frame_id = marker.read(img)
        out = await asyncio.to_thread(self.processor.process, img)
        if frame_id is not None:
            marker.write(out, frame_id)
        self.stats.process_ms += (time.perf_counter() - t0) * 1000
        self.stats.frames += 1

        new = VideoFrame.from_ndarray(out, format="rgb24")
        new.pts = frame.pts
        new.time_base = frame.time_base
        return new

    def stop(self):
        self._reader.cancel()
        super().stop()


class Offer(BaseModel):
    sdp: str
    type: str


@app.get("/garments")
def garments() -> list[str]:
    return json.loads(GARMENTS.read_text())


@app.post("/offer")
async def offer(body: Offer) -> dict:
    pc = RTCPeerConnection()
    peers.add(pc)
    processor = processors.make(PROCESSOR, SIMULATE_MS)
    stats = Stats()

    @pc.on("datachannel")
    def on_datachannel(channel):
        async def report():
            while channel.readyState == "open":
                await asyncio.sleep(1)
                channel.send(json.dumps(stats.snapshot()))

        @channel.on("open")
        def on_open():
            asyncio.ensure_future(report())

        @channel.on("message")
        def on_message(message):
            msg = json.loads(message)
            if msg.get("type") == "garment":
                processor.garment = msg["name"]
                log.info("garment -> %s", processor.garment)

        if channel.readyState == "open":
            on_open()

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            pc.addTrack(ProcessedTrack(track, processor, stats))

    @pc.on("connectionstatechange")
    async def on_state():
        log.info("connection %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            peers.discard(pc)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=body.sdp, type=body.type))
    await pc.setLocalDescription(await pc.createAnswer())
    return {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}


@app.on_event("shutdown")
async def shutdown():
    await asyncio.gather(*(pc.close() for pc in peers))
    peers.clear()
