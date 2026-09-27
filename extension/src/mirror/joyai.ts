// Client for JoyAI-Video-Edit's streaming server (deploy/xvideo/serving/serve_joyomni_streaming.py),
// mirroring what its own static/index.html does, MJPEG in both directions.

export type Status =
  | { kind: "connecting" }
  | { kind: "queued"; ahead: number }
  | { kind: "starting" }
  | { kind: "live"; width: number; height: number }
  | { kind: "closed"; reason: string };

export type StartOptions = { prompt: string; refImage: string };

type Handlers = {
  onStatus: (s: Status) => void;
  onFrame: (jpeg: Blob, latencyMs: number) => void;
};

// Same limit as the reference client: stop sending once this many frames are unacknowledged.
const MAX_UNACKED_FRAMES = 32;
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
  private pendingOutput: { t_capture_ms: number } | null = null;
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(wsUrl: string, private handlers: Handlers) {
    handlers.onStatus({ kind: "connecting" });
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => this.onMessage(e.data);
    this.ws.onclose = (e) => {
      this.live = false;
      handlers.onStatus({ kind: "closed", reason: e.reason || `connection closed (${e.code})` });
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
    return this.live && this.ws.readyState === WebSocket.OPEN && this.sent - this.framesIn < MAX_UNACKED_FRAMES;
  }

  sendFrame(jpeg: ArrayBuffer, tCaptureMs: number) {
    if (!this.canSendFrame) return;
    this.sent += 1;
    this.send({ type: "frame_meta", seq: this.sent, t_capture_ms: tCaptureMs });
    this.ws.send(jpeg);
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
      // Only orientation matters; the server snaps to its own 840x480.
      width: 840,
      height: 480,
      input_codec: "mjpeg",
      output_codec: "mjpeg",
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
      if (!meta) return;
      this.received += 1;
      if (this.received % 4 === 0) this.send({ type: "ack", recv: this.received });
      this.handlers.onFrame(new Blob([data], { type: "image/jpeg" }), Date.now() - meta.t_capture_ms);
      return;
    }

    const msg = JSON.parse(data);
    // After a garment switch, drop what the server still sends for the previous session.
    if (SESSION_SCOPED.has(msg.type) && msg.session_id !== this.sessionId) return;
    switch (msg.type) {
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
        this.pendingOutput = { t_capture_ms: msg.t_capture_ms };
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
