// Frames come back in bursts of 8 (one model chunk). Shown on arrival, the viewer sees one jump per chunk.
// Instead each frame is shown at its capture time plus a steady delay, which restores the camera's cadence.
// The delay tracks the oldest recent arrival and decays slowly, as in JoyAI's own client.

type Item = { bitmap: ImageBitmap; tCapture: number };

const MAX_QUEUE = 32;
const DELAY_DECAY = 0.99;

export class PacedPlayer {
  private queue: Item[] = [];
  private delayMs = 0;
  private lastShown = 0;
  private raf = 0;

  constructor(
    private ctx: CanvasRenderingContext2D,
    private onShown: (latencyMs: number) => void,
  ) {
    this.raf = requestAnimationFrame(this.tick);
  }

  async push(frame: VideoFrame, tCapture: number) {
    // Holding VideoFrames starves the hardware decoder's buffer pool, so copy out and release at once.
    const bitmap = await createImageBitmap(frame);
    frame.close();
    const age = Date.now() - tCapture;
    if (tCapture <= this.lastShown || age > 5000) return bitmap.close();
    this.delayMs = Math.max(age, this.delayMs * DELAY_DECAY);
    this.queue.push({ bitmap, tCapture });
    this.queue.sort((a, b) => a.tCapture - b.tCapture);
    while (this.queue.length > MAX_QUEUE) this.queue.shift()!.bitmap.close();
  }

  /** Start fresh after a garment switch so the old session's delay doesn't carry over. */
  reset() {
    this.queue.forEach((i) => i.bitmap.close());
    this.queue = [];
    this.delayMs = 0;
    this.lastShown = 0;
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.reset();
  }

  private tick = () => {
    const due = Date.now() - this.delayMs;
    let item: Item | undefined;
    // Show the newest frame that is due; anything older than it is skipped.
    while (this.queue.length && this.queue[0].tCapture <= due) {
      item?.bitmap.close();
      item = this.queue.shift();
    }
    if (item) {
      this.ctx.drawImage(item.bitmap, 0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
      item.bitmap.close();
      this.lastShown = item.tCapture;
      this.onShown(Date.now() - item.tCapture);
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
