"""Frame-id stamp painted into pixels so capture-to-display latency survives encode, decode and any model.

Layout is relative to frame size because WebRTC may downscale frames under bandwidth pressure.
Must stay in sync with web/lib/marker.ts.
"""

import numpy as np

SYNC = (1, 0)
ID_BITS = 16
BLOCKS = len(SYNC) + ID_BITS
BLOCK_W_FRAC = 1 / 32
BLOCK_H_FRAC = 1 / 24


def _block_rect(i: int, h: int, w: int) -> tuple[int, int, int, int]:
    bw = max(1, round(w * BLOCK_W_FRAC))
    bh = max(1, round(h * BLOCK_H_FRAC))
    return 0, bh, i * bw, (i + 1) * bw


def read(frame: np.ndarray) -> int | None:
    h, w = frame.shape[:2]
    bits = []
    for i in range(BLOCKS):
        y0, y1, x0, x1 = _block_rect(i, h, w)
        # Sample the block centre only: edges bleed into neighbours after compression.
        cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
        dy, dx = max(1, (y1 - y0) // 4), max(1, (x1 - x0) // 4)
        luma = frame[cy - dy : cy + dy, cx - dx : cx + dx, :3].mean()
        bits.append(1 if luma > 127 else 0)
    if tuple(bits[: len(SYNC)]) != SYNC:
        return None
    value = 0
    for b in bits[len(SYNC) :]:
        value = (value << 1) | b
    return value


def write(frame: np.ndarray, frame_id: int) -> None:
    h, w = frame.shape[:2]
    bits = list(SYNC) + [(frame_id >> (ID_BITS - 1 - k)) & 1 for k in range(ID_BITS)]
    for i, b in enumerate(bits):
        y0, y1, x0, x1 = _block_rect(i, h, w)
        frame[y0:y1, x0:x1, :3] = 255 if b else 0
