// Client for JoyAI-Video-Edit's streaming server (deploy/xvideo/serving/serve_joyomni_streaming.py),
// mirroring what its own static/index.html does, with H.264 in both directions.

import type { OutputMeta } from "./codec";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./media";

export type Status =
  | { kind: "connecting" }
  | { kind: "queued"; ahead: number }
  | { kind: "starting" }
  | { kind: "live"; width: number; height: number }
  | { kind: "closed"; reason: string };

export type StartOptions = { prompt: string; refImage: string };

type Handlers = {
  onStatus: (s: Status) => void;
  /** An encoded H.264 access unit; the caller decodes it. */
  onFrame: (data: ArrayBuffer, meta: OutputMeta) => void;
};

// One chunk's worth. The reference client allows 32, but every queued frame is latency the user sees;
// dropping at the source is better than queueing behind a slow uplink.
const MAX_UNACKED_FRAMES = 8;
const MAX_BUFFERED_BYTES = 256 * 1024;
const SESSION_SCOPED = new Set(["started", "accepted", "chunk_start", "output_frame", "chunk_done"]);

export class JoyAIClient {
  private ws: WebSocket;
  private sessionSerial = 0;
  private sessionId = "";
  private granted = false;
  private pendingStart: StartOptions | null = null;
  private live = false;
  private sent = 0;
  private framesIn = 0;
  private received = 0;
  private pendingOutput: OutputMeta | null = null;
  private pingTimer: ReturnType<typeof setInterval>;
  private bytesUp = 0;
  private bytesDown = 0;
  rttMs: number | null = null;

  constructor(wsUrl: string, private handlers: Handlers) {
    handlers.onStatus({ kind: "connecting" });
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onclose = (e) => {
      this.live = false;
      console.info("Toshoyna: socket closed", e.code, e.reason);
      handlers.onStatus({ kind: "closed", reason: e.reason || "lost the connection to the server" });
    };
    // Pings carry our receive count, which the server uses to drop chunks when the downlink falls behind.
    this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now(), recv: this.received }), 1000);
  }

  /** Starts a session, or restarts it with a new garment or prompt. */
  start(opts: StartOptions) {
    this.pendingStart = opts;
    if (this.granted) this.sendStart();
  }

  get canSendFrame() {
    return (
      this.live &&
      this.ws.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount < MAX_BUFFERED_BYTES &&
      this.sent - this.framesIn < MAX_UNACKED_FRAMES
    );
  }

  /** Encoded frames must all be sent once encoded (dropping deltas corrupts the stream), so gate on canSendFrame before encoding. */
  sendFrame(data: ArrayBuffer, tCaptureMs: number) {
    if (!this.live || this.ws.readyState !== WebSocket.OPEN) return;
    this.sent += 1;
    this.send({ type: "frame_meta", seq: this.sent, t_capture_ms: tCaptureMs });
    this.ws.send(data);
    this.bytesUp += data.byteLength;
  }

  /** Bytes sent and received since the previous call. */
  takeTraffic() {
    const t = { up: this.bytesUp, down: this.bytesDown };
    this.bytesUp = this.bytesDown = 0;
    return t;
  }

  close() {
    clearInterval(this.pingTimer);
    this.send({ type: "stop" });
    this.ws.close();
  }

  private sendStart() {
    if (!this.pendingStart) return;
    this.sessionSerial += 1;
    this.sessionId = String(this.sessionSerial);
    this.live = false;
    this.sent = this.framesIn = this.received = 0;
    this.pendingOutput = null;
    this.handlers.onStatus({ kind: "starting" });
    this.send({
      type: "start",
      prompt: this.pendingStart.prompt,
      ref_image: this.pendingStart.refImage,
      // Only orientation matters; the server snaps to its own size for that orientation.
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      input_codec: "h264",
      output_codec: "h264",
      use_pe: false,
    });
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ session_id: this.sessionId, ...msg }));
  }

  private onMessage(data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      // Each binary output frame is announced by the output_frame JSON just before it.
      const meta = this.pendingOutput;
      this.pendingOutput = null;
      this.bytesDown += data.byteLength;
      if (!meta) return;
      this.received += 1;
      if (this.received % 4 === 0) this.send({ type: "ack", recv: this.received });
      this.handlers.onFrame(data, meta);
      return;
    }

    const msg = JSON.parse(data);
    // After a garment switch, drop what the server still sends for the previous session.
    if (SESSION_SCOPED.has(msg.type) && msg.session_id !== this.sessionId) return;
    switch (msg.type) {
      case "pong":
        if (typeof msg.t === "number") this.rttMs = Date.now() - msg.t;
        break;
      case "queue_position":
        this.handlers.onStatus({ kind: "queued", ahead: msg.ahead ?? msg.position ?? 0 });
        break;
      case "session_granted":
        this.granted = true;
        this.sendStart();
        break;
      case "started":
        this.live = true;
        this.handlers.onStatus({ kind: "live", width: msg.width, height: msg.height });
        break;
      case "accepted":
        this.framesIn = Math.max(this.framesIn, msg.frames_in ?? 0);
        break;
      case "output_frame":
        this.pendingOutput = { t_capture_ms: msg.t_capture_ms, key: !!msg.key };
        break;
      case "chunk_done":
        this.framesIn = Math.max(this.framesIn, msg.frames_in ?? 0);
        this.send({ type: "ack", recv: this.received });
        break;
      case "session_timeout":
        this.handlers.onStatus({ kind: "closed", reason: "session timed out" });
        break;
      case "error":
        this.handlers.onStatus({ kind: "closed", reason: msg.message ?? "server error" });
        break;
    }
  }
}
