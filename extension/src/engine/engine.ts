// Runs in the offscreen document: owns the camera, the JoyAI session and the uplink encoder, and
// broadcasts the edited stream to whichever viewers are open. It closes itself when none are left.

import { BUS_NAME, type BusMessage, type EngineMessage, type EnginePhase, type ViewerSettings } from "../bus";
import { UplinkEncoder } from "../mirror/codec";
import { instructionFor } from "../mirror/garment";
import { JoyAIClient } from "../mirror/joyai";
import { drawMirroredFrame, loadRefImage } from "../mirror/media";
import type { Product } from "../types";

const SEND_FPS = 24;
// Long enough to survive a viewer reloading or the float being replaced by the full window.
const NO_VIEWER_GRACE_MS = 15_000;
const VIEWER_STALE_MS = 6_000;

const bus = new BroadcastChannel(BUS_NAME);
const viewers = new Map<string, number>();
let settings: ViewerSettings | null = null;
let phase: EnginePhase = { kind: "waking", seconds: 0 };
let run: Run | null = null;
let lastViewerSeen = Date.now();

function post(msg: EngineMessage) {
  bus.postMessage(msg);
}

function setPhase(p: EnginePhase) {
  phase = p;
  post({ from: "engine", type: "phase", phase: p });
}

/** Modal cold-starts the GPU container on the first request; /health blocks or fails until JoyAI is loaded. */
async function waitForServer(base: string, signal: AbortSignal) {
  const t0 = Date.now();
  while (!signal.aborted) {
    setPhase({ kind: "waking", seconds: Math.round((Date.now() - t0) / 1000) });
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (res.ok && (await res.json()).runtime_loaded) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function loadProductImage(product: Product) {
  try {
    return await loadRefImage(product.src);
  } catch {
    // The high-resolution guess can 404 or be blocked; the image the page showed is known to load.
    return loadRefImage(product.shownSrc);
  }
}

/** One connection to one server: wake it, open the camera, stream. Replaced wholesale on retry or server change. */
class Run {
  readonly serverUrl: string;
  private abort = new AbortController();
  private stream: MediaStream | null = null;
  private client: JoyAIClient | null = null;
  private encoder: UplinkEncoder | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private startedKey = "";

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.go().catch((e) => !this.abort.signal.aborted && setPhase({ kind: "error", message: String(e) }));
  }

  private async go() {
    await waitForServer(this.serverUrl, this.abort.signal);
    if (this.abort.signal.aborted) return;

    setPhase({ kind: "camera" });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    } catch (e) {
      // Offscreen documents can't show the permission prompt; a visible extension page has to ask once.
      if (e instanceof DOMException && e.name === "NotAllowedError") return setPhase({ kind: "needs-camera" });
      throw e;
    }
    if (this.abort.signal.aborted) return this.stopCamera();
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = this.stream;
    await video.play();

    const client = new JoyAIClient(this.serverUrl.replace(/^http/, "ws") + "/ws", {
      onStatus: (status, started) => {
        setPhase(status);
        // Each server session starts a fresh H.264 stream.
        this.encoder?.close();
        this.encoder = null;
        if (status.kind === "live") this.encoder = new UplinkEncoder(started!.size, SEND_FPS, (data, t) => client.sendFrame(data, t));
        if (status.kind === "closed") this.startedKey = "";
      },
      onFrame: (data, meta) => post({ from: "engine", type: "frame", data, meta }),
    });
    this.client = client;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    this.timers.push(
      setInterval(() => {
        const encoder = this.encoder;
        if (!encoder || !client.canSendFrame) return;
        if (canvas.width !== encoder.size.width || canvas.height !== encoder.size.height) {
          canvas.width = encoder.size.width;
          canvas.height = encoder.size.height;
        }
        const t = Date.now();
        drawMirroredFrame(ctx, video);
        encoder.encode(canvas, t);
      }, 1000 / SEND_FPS),
      setInterval(() => {
        const { up, down } = client.takeTraffic();
        post({ from: "engine", type: "stats", net: { rtt: client.rttMs, upMbit: (up * 8) / 1e6, downMbit: (down * 8) / 1e6 } });
      }, 1000),
    );
    this.applySettings();
  }

  /** (Re)starts the server session when the product, instruction or orientation changed. */
  applySettings() {
    const s = settings;
    if (!this.client || !s?.product) return;
    const prompt = s.prompt ?? instructionFor(s.product.name);
    const key = JSON.stringify([s.product.src, prompt, s.size]);
    if (key === this.startedKey) return;
    this.startedKey = key;
    const client = this.client;
    loadProductImage(s.product)
      .then((refImage) => this.client === client && key === this.startedKey && client.start({ prompt, refImage, size: s.size }))
      .catch((e) => setPhase({ kind: "error", message: `Couldn't load the product photo (${e}). Try picking another image.` }));
  }

  private stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stop() {
    this.abort.abort();
    this.timers.forEach(clearInterval);
    this.encoder?.close();
    this.client?.close();
    this.client = null;
    this.stopCamera();
  }
}

function restart() {
  run?.stop();
  run = settings ? new Run(settings.serverUrl) : null;
}

function onSettings(next: ViewerSettings) {
  const serverChanged = settings?.serverUrl !== next.serverUrl;
  settings = next;
  if (!run || serverChanged) restart();
  else run.applySettings();
}

bus.onmessage = (e: MessageEvent<BusMessage>) => {
  const msg = e.data;
  if (msg.from === "engine") return;
  if (msg.from === "permission") {
    if (phase.kind === "needs-camera") restart();
    return;
  }
  switch (msg.type) {
    case "hello":
      viewers.set(msg.viewerId, Date.now());
      post({ from: "engine", type: "phase", phase });
      onSettings(msg.settings);
      break;
    case "settings":
      viewers.set(msg.viewerId, Date.now());
      onSettings(msg.settings);
      break;
    case "heartbeat":
      viewers.set(msg.viewerId, Date.now());
      break;
    case "bye":
      viewers.delete(msg.viewerId);
      break;
    case "retry":
      restart();
      break;
  }
};

setInterval(() => {
  const now = Date.now();
  // Lets viewers that joined before this document loaded notice it and say hello again.
  post({ from: "engine", type: "phase", phase });
  for (const [id, seen] of viewers) if (now - seen > VIEWER_STALE_MS) viewers.delete(id);
  if (viewers.size) lastViewerSeen = now;
  else if (now - lastViewerSeen > NO_VIEWER_GRACE_MS) {
    run?.stop();
    // Releases the camera light and the server's single session slot.
    window.close();
  }
}, 2000);
