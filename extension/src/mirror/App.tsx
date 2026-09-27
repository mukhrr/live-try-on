import { useEffect, useRef, useState } from "react";
import type { Product } from "../types";
import { JoyAIClient, type Status } from "./joyai";
import { drawMirroredFrame, FRAME_HEIGHT, FRAME_WIDTH, loadRefImage } from "./media";

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL ?? "https://mshakhriyorov8--live-try-on-joyai-serve-dev.modal.run";
const DEFAULT_PROMPT = "Put the clothes from Image 1 on the model in the video";
const SEND_FPS = 24;
const LATENCY_WINDOW = 48;

type Phase = { kind: "waking"; seconds: number } | { kind: "camera" } | { kind: "error"; message: string } | Status;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Modal cold-starts the GPU container on the first request; /health blocks or fails until JoyAI is loaded. */
async function waitForServer(base: string, signal: AbortSignal, onTick: (s: number) => void) {
  const t0 = Date.now();
  while (!signal.aborted) {
    onTick(Math.round((Date.now() - t0) / 1000));
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      if (res.ok && (await res.json()).runtime_loaded) return;
    } catch {
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<JoyAIClient | null>(null);
  const latencies = useRef<number[]>([]);
  const outUrl = useRef<string | null>(null);

  const [server, setServer] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const [phase, setPhase] = useState<Phase>({ kind: "waking", seconds: 0 });
  const [connected, setConnected] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    chrome.storage.local.get("serverUrl").then(({ serverUrl }) => setServer((serverUrl as string) || DEFAULT_SERVER));
    chrome.storage.session.get("product").then(({ product }) => product && setProduct(product as Product));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes.product?.newValue) setProduct(changes.product.newValue as Product);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (!server) return;
    const abort = new AbortController();
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    (async () => {
      await waitForServer(server, abort.signal, (seconds) => setPhase({ kind: "waking", seconds }));
      if (abort.signal.aborted) return;

      setPhase({ kind: "camera" });
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      if (abort.signal.aborted) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const client = new JoyAIClient(server.replace(/^http/, "ws") + "/ws", {
        onStatus: setPhase,
        onFrame: (jpeg, ms) => {
          if (outUrl.current) URL.revokeObjectURL(outUrl.current);
          outUrl.current = URL.createObjectURL(jpeg);
          setOutput(outUrl.current);
          latencies.current.push(ms);
          if (latencies.current.length > LATENCY_WINDOW) latencies.current.shift();
        },
      });
      clientRef.current = client;
      setConnected(true);

      const canvas = document.createElement("canvas");
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const ctx = canvas.getContext("2d")!;
      let busy = false;
      timer = setInterval(async () => {
        if (busy || !client.canSendFrame) return;
        busy = true;
        const t = Date.now();
        drawMirroredFrame(ctx, video);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.6));
        if (blob) client.sendFrame(await blob.arrayBuffer(), t);
        busy = false;
      }, 1000 / SEND_FPS);
    })().catch((e) => setPhase({ kind: "error", message: String(e) }));

    const stats = setInterval(() => latencies.current.length && setLatency(median(latencies.current)), 500);
    return () => {
      abort.abort();
      clearInterval(timer);
      clearInterval(stats);
      clientRef.current?.close();
      clientRef.current = null;
      setConnected(false);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [server]);

  useEffect(() => {
    if (!connected || !product) return;
    let cancelled = false;
    loadRefImage(product.src)
      .then((refImage) => !cancelled && clientRef.current?.start({ prompt, refImage }))
      .catch((e) => setPhase({ kind: "error", message: `Couldn't load the product photo: ${e}` }));
    latencies.current = [];
    setLatency(null);
    return () => {
      cancelled = true;
    };
  }, [connected, product, prompt]);

  return (
    <main className="flex h-screen flex-col bg-black font-sans text-white">
      <div className="relative flex-1 overflow-hidden">
        {output ? (
          <img src={output} alt="You, wearing the product" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-400">
            {statusText(phase, product)}
          </div>
        )}
        <video ref={videoRef} muted playsInline className="hidden" />

        {product && (
          <img
            src={product.src}
            alt={product.alt || "Selected product"}
            title={product.alt}
            className="absolute bottom-3 left-3 h-16 w-16 rounded-lg border border-white/30 bg-white object-contain"
          />
        )}
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 font-mono text-xs">
          <span className={`h-2 w-2 rounded-full ${phase.kind === "live" ? "bg-emerald-400" : "bg-amber-400"}`} />
          {phase.kind === "live" && latency !== null ? `${Math.round(latency)} ms` : phase.kind}
        </div>
      </div>

      <form
        className="flex gap-2 border-t border-white/10 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPrompt(draftPrompt.trim() || DEFAULT_PROMPT);
        }}
      >
        <input
          value={draftPrompt}
          onChange={(e) => setDraftPrompt(e.target.value)}
          className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-amber-400"
          aria-label="Instruction"
        />
        <button type="button" onClick={() => setShowSettings((v) => !v)} className="rounded px-2 text-sm text-zinc-400 hover:text-white">
          Server
        </button>
      </form>
      {showSettings && server && (
        <form
          className="flex gap-2 p-2 pt-0"
          onSubmit={(e) => {
            e.preventDefault();
            const url = String(new FormData(e.currentTarget).get("url")).replace(/\/+$/, "");
            chrome.storage.local.set({ serverUrl: url });
            setServer(url);
            setShowSettings(false);
          }}
        >
          <input name="url" defaultValue={server} className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-xs" aria-label="Server URL" />
          <button className="rounded bg-amber-400 px-2 text-xs font-medium text-black">Save</button>
        </form>
      )}
    </main>
  );
}

function statusText(phase: Phase, product: Product | null) {
  if (!product) return "Click the Toshoyna icon on a shop page, then click a product photo.";
  switch (phase.kind) {
    case "waking":
      return `Waking up the mirror… ${phase.seconds}s (the first start after a break takes about 2 minutes)`;
    case "camera":
      return "Allow camera access to see yourself in the mirror.";
    case "connecting":
      return "Connecting…";
    case "queued":
      return `Someone else is using the mirror. You're next after ${phase.ahead}.`;
    case "starting":
      return "Dressing you up…";
    case "live":
      return "Hold still for a second…";
    case "closed":
      return `Mirror stopped: ${phase.reason}. Reopen to try again.`;
    case "error":
      return phase.message;
  }
}
