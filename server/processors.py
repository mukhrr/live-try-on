import time

import numpy as np


class FrameProcessor:
    """One RGB frame in, one RGB frame out. A model plugs in here without touching transport."""

    garment: str | None = None

    def process(self, frame: np.ndarray) -> np.ndarray:
        raise NotImplementedError


class Passthrough(FrameProcessor):
    def process(self, frame: np.ndarray) -> np.ndarray:
        return frame


class Dummy(FrameProcessor):
    """Tints the frame per garment so it's visible the video went through the server.

    simulate_ms sleeps per frame to mimic model compute and exercise frame dropping.
    """

    TINTS = {
        "red_denim": (1.3, 0.8, 0.8),
        "leather": (0.6, 0.6, 0.6),
        "suit": (0.8, 0.8, 1.3),
        "raincoat": (1.3, 1.3, 0.6),
    }

    def __init__(self, simulate_ms: float = 0.0):
        self.simulate_ms = simulate_ms

    def process(self, frame: np.ndarray) -> np.ndarray:
        if self.simulate_ms:
            time.sleep(self.simulate_ms / 1000)
        tint = self.TINTS.get(self.garment or "")
        if tint is None:
            return frame
        return np.clip(frame * np.array(tint, dtype=np.float32), 0, 255).astype(np.uint8)


def make(name: str, simulate_ms: float = 0.0) -> FrameProcessor:
    if name == "passthrough":
        return Passthrough()
    if name == "dummy":
        return Dummy(simulate_ms)
    raise ValueError(f"unknown processor: {name}")
