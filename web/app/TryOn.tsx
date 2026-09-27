"use client";

import { useEffect, useRef, useState } from "react";
import * as marker from "@/lib/marker";

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8000";
const WIDTH = 640;
const HEIGHT = 480;
const WINDOW = 150;

type ServerStats = { fps_out: number; dropped: number; process_ms: number | null };

type Latency = { last: number; p50: number; p95: number; fps: number };

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export default function TryOn() {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const stopRef = useRef<() => void>(() => {});

  const [garments, setGarments] = useState<string[]>([]);
  const [garment, setGarment] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [latency, setLatency] = useState<Latency | null>(null);
  const [server, setServer] = useState<ServerStats | null>(null);

  useEffect(() => {
    fetch(`${SERVER}/garments`)
      .then((r) => r.json())
      .then(setGarments)
      .catch(() => setStatus(`can't reach ${SERVER}`));
    return () => stopRef.current();
  }, []);

  async function start() {
    setStatus("starting camera");
    const cam = await navigator.mediaDevices.getUserMedia({
      video: { width: WIDTH, height: HEIGHT, frameRate: 30 },
      audio: false,
    });
    const local = localRef.current!;
    local.srcObject = cam;
    await local.play();

    // Frames go out through a canvas so each one carries its id in pixels.
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d")!;
    const sentAt = new Float64Array(marker.ID_MOD);
    let nextId = 0;
    let running = true;

    const stamp = () => {
      if (!running) return;
      ctx.drawImage(local, 0, 0, WIDTH, HEIGHT);
      marker.write(ctx, WIDTH, HEIGHT, nextId);
      sentAt[nextId] = performance.now();
      nextId = (nextId + 1) % marker.ID_MOD;
      local.requestVideoFrameCallback(stamp);
    };
    local.requestVideoFrameCallback(stamp);

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    const dc = pc.createDataChannel("control");
    dcRef.current = dc;
    dc.onopen = () => garment && dc.send(JSON.stringify({ type: "garment", name: garment }));
    dc.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "stats") setServer(msg);
    };

    const out = canvas.captureStream(30);
    pc.addTrack(out.getVideoTracks()[0], out);

    const remote = remoteRef.current!;
    const readCanvas = document.createElement("canvas");
    const readCtx = readCanvas.getContext("2d", { willReadFrequently: true })!;
    const samples: number[] = [];
    let frames = 0;
    let fps = 0;
    let fpsSince = 0;

    const onRemoteFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (!running) return;
      const w = meta.width;
      const h = meta.height;
      if (readCanvas.width !== w || readCanvas.height !== h) {
        readCanvas.width = w;
        readCanvas.height = h;
      }
      const strip = marker.stripHeight(h);
      readCtx.drawImage(remote, 0, 0, w, h);
      const id = marker.read(readCtx.getImageData(0, 0, w, strip).data, w, h);
      if (id !== null && sentAt[id]) {
        samples.push(meta.expectedDisplayTime - sentAt[id]);
        if (samples.length > WINDOW) samples.shift();
      }

      frames++;
      const t = performance.now();
      if (!fpsSince) fpsSince = t;
      if (t - fpsSince >= 1000) {
        fps = (frames * 1000) / (t - fpsSince);
        frames = 0;
        fpsSince = t;
        if (samples.length) {
          const sorted = [...samples].sort((a, b) => a - b);
          setLatency({
            last: samples[samples.length - 1],
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            fps,
          });
        }
      }
      remote.requestVideoFrameCallback(onRemoteFrame);
    };

    pc.ontrack = (e) => {
      remote.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      remote.play();
      remote.requestVideoFrameCallback(onRemoteFrame);
    };
    pc.onconnectionstatechange = () => setStatus(pc.connectionState);

    setStatus("connecting");
    await pc.setLocalDescription(await pc.createOffer());
    // aiortc doesn't trickle ICE, so send the offer with all candidates in it.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      });
    });
    const res = await fetch(`${SERVER}/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pc.localDescription),
    });
    await pc.setRemoteDescription(await res.json());

    stopRef.current = () => {
      running = false;
      pc.close();
      cam.getTracks().forEach((t) => t.stop());
      out.getTracks().forEach((t) => t.stop());
      pcRef.current = null;
      dcRef.current = null;
      setStatus("idle");
      setLatency(null);
      setServer(null);
    };
  }

  function pick(name: string) {
    setGarment(name);
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify({ type: "garment", name }));
    }
  }

  const live = status !== "idle" && !status.startsWith("can't");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Live try-on</h1>
        <span className="text-sm text-zinc-500">{status}</span>
        <button
          onClick={() => (live ? stopRef.current() : start().catch((e) => setStatus(String(e))))}
          className="ml-auto rounded bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          {live ? "Stop" : "Start"}
        </button>
      </header>

      <div className="flex flex-wrap gap-2">
        {garments.map((g) => (
          <button
            key={g}
            onClick={() => pick(g)}
            className={`rounded border px-3 py-1 text-sm ${
              g === garment ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900" : "border-zinc-300 dark:border-zinc-700"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <figure className="relative">
          <video ref={localRef} muted playsInline className="aspect-[4/3] w-full -scale-x-100 rounded bg-zinc-200 dark:bg-zinc-800" />
          <figcaption className="absolute left-2 top-8 rounded bg-black/60 px-2 py-0.5 text-xs text-white">camera</figcaption>
        </figure>
        <figure className="relative">
          <video ref={remoteRef} muted playsInline className="aspect-[4/3] w-full -scale-x-100 rounded bg-zinc-200 dark:bg-zinc-800" />
          <figcaption className="absolute left-2 top-8 space-y-0.5 rounded bg-black/60 px-2 py-1 font-mono text-xs text-white">
            <div>output</div>
            {latency && (
              <div>
                latency {latency.last.toFixed(0)}ms · p50 {latency.p50.toFixed(0)} · p95 {latency.p95.toFixed(0)} · {latency.fps.toFixed(0)}fps
              </div>
            )}
            {server && (
              <div>
                server {server.process_ms ?? "–"}ms/frame · {server.fps_out}fps · dropped {server.dropped}/s
              </div>
            )}
          </figcaption>
        </figure>
      </div>
    </main>
  );
}
