// H.264 over the websocket, configured like JoyAI's own client (static/index.html). JPEG frames at 24 FPS
// were ~8-10 Mbit/s each way, which saturates a home uplink and turns into seconds of queueing.

import { FRAME_HEIGHT, FRAME_WIDTH } from "./media";

const KEYFRAME_INTERVAL = 8;
// JoyAI's "high" uplink tier: 0.6 * 4 Mbit/s at 1248x720 16 FPS, scaled to our 480x840 frame at 24 FPS (~1.3 Mbit/s).
const UPLINK_BITRATE = Math.round(0.6 * 4_000_000 * ((FRAME_WIDTH * FRAME_HEIGHT) / (1248 * 720)) * Math.sqrt(24 / 16));

export class UplinkEncoder {
  private encoder: VideoEncoder;
  private seq = 0;
  private captureTimes = new Map<number, number>();

  constructor(fps: number, onChunk: (data: ArrayBuffer, tCaptureMs: number) => void) {
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const t = this.captureTimes.get(chunk.timestamp);
        this.captureTimes.delete(chunk.timestamp);
        if (t === undefined) return;
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        onChunk(data, t);
      },
      error: (e) => console.error("Toshoyna encoder", e),
    });
    this.encoder.configure({
      codec: "avc1.42E028",
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      bitrate: UPLINK_BITRATE,
      framerate: fps,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
  }

  /** The first frame after construction is a keyframe, so recreate the encoder for each new server session. */
  encode(source: CanvasImageSource, tCaptureMs: number) {
    // Frames still queued in the encoder are already late; skip rather than add to the pile.
    if (this.encoder.encodeQueueSize > 2) return;
    this.seq += 1;
    this.captureTimes.set(this.seq, tCaptureMs);
    const frame = new VideoFrame(source, { timestamp: this.seq });
    this.encoder.encode(frame, { keyFrame: this.seq === 1 || this.seq % KEYFRAME_INTERVAL === 0 });
    frame.close();
  }

  close() {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

export type OutputMeta = { t_capture_ms: number; key?: boolean };

export class DownlinkDecoder {
  private decoder: VideoDecoder;
  private seq = 0;
  private metas = new Map<number, OutputMeta>();

  constructor(onFrame: (frame: VideoFrame, meta: OutputMeta) => void) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const meta = this.metas.get(frame.timestamp);
        this.metas.delete(frame.timestamp);
        if (meta) onFrame(frame, meta);
        else frame.close();
      },
      error: (e) => console.error("Toshoyna decoder", e),
    });
    this.decoder.configure({ codec: "avc1.640028", optimizeForLatency: true });
  }

  decode(data: ArrayBuffer, meta: OutputMeta) {
    // Deltas are undecodable until the first keyframe of the session arrives.
    if (this.seq === 0 && !meta.key) return;
    this.seq += 1;
    this.metas.set(this.seq, meta);
    this.decoder.decode(new EncodedVideoChunk({ type: meta.key ? "key" : "delta", timestamp: this.seq, data }));
  }

  close() {
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
