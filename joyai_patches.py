"""Build-time patches to JoyAI-Video-Edit, applied in the Modal image.

A cold start compiles while warming up, and the upstream timeouts assume a warm compile cache:
the 4-chunk warmup gets 120s (the first chunk alone took 53s) and closing the warmup session waits
5s for a decode worker that is still compiling, which aborts server startup.
"""
from pathlib import Path

path = Path("/opt/joyai/deploy/xvideo/serving/joyomni_streaming.py")
src = path.read_text()
patches = [
    ("            deadline = time.time() + 120.0\n", "            deadline = time.time() + 1800.0\n"),
    ("                session.close()\n\nclass JoyOmniV2VStreamingSession", "                session.close(timeout=600.0)\n\nclass JoyOmniV2VStreamingSession"),
]
for old, new in patches:
    assert src.count(old) == 1, f"patch target not unique or missing: {old!r}"
    src = src.replace(old, new)
path.write_text(src)
print("joyai patches applied")
