import { useEffect, useRef, useState } from "react";
import type { Product } from "../types";
import { DownlinkDecoder, UplinkEncoder } from "./codec";
import { garmentNoun, instructionFor } from "./garment";
import { JoyAIClient, type Status } from "./joyai";
import { drawMirroredFrame, FRAME_HEIGHT, FRAME_WIDTH, loadRefImage } from "./media";
import { PacedPlayer } from "./playback";

const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL ?? "https://mshakhriyorov8--live-try-on-joyai-serve-dev.modal.run";
const SEND_FPS = 24;
const LATENCY_WINDOW = 48;

type NetStats = { rtt: number | null; upMbit: number; downMbit: number; fps: number };

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

async function loadProductImage(product: Product) {
  try {
    return await loadRefImage(product.src);
  } catch {
    // The high-resolution guess can 404 or be blocked; the image the page showed is known to load.
    return loadRefImage(product.shownSrc);
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const outRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<JoyAIClient | null>(null);
  const latencies = useRef<number[]>([]);
  const shownFrames = useRef(0);

  const [server, setServer] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [customPrompt, setCustomPrompt] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "waking", seconds: 0 });
  const [connected, setConnected] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [net, setNet] = useState<NetStats | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const prompt = customPrompt ?? (product ? instructionFor(product.name) : "");

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
    let closePlayer = () => {};
    setHasOutput(false);

    (async () => {
      await waitForServer(server, abort.signal, (seconds) => setPhase({ kind: "waking", seconds }));
      if (abort.signal.aborted) return;

      setPhase({ kind: "camera" });
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      if (abort.signal.aborted) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      let encoder: UplinkEncoder | null = null;
      let decoder: DownlinkDecoder | null = null;
      const player = new PacedPlayer(outRef.current!.getContext("2d")!, (ms) => {
        setHasOutput(true);
        shownFrames.current += 1;
        latencies.current.push(ms);
        if (latencies.current.length > LATENCY_WINDOW) latencies.current.shift();
      });
      closePlayer = () => player.close();

      const client = new JoyAIClient(server.replace(/^http/, "ws") + "/ws", {
        onStatus: (status) => {
          setPhase(status);
          // Each server session starts a fresh H.264 stream in both directions.
          encoder?.close();
          decoder?.close();
          encoder = decoder = null;
          player.reset();
          if (status.kind !== "live") return;
          encoder = new UplinkEncoder(SEND_FPS, (data, t) => client.sendFrame(data, t));
          decoder = new DownlinkDecoder((frame, meta) => void player.push(frame, meta.t_capture_ms));
        },
        onFrame: (data, meta) => decoder?.decode(data, meta),
      });
      clientRef.current = client;
      setConnected(true);

      const canvas = document.createElement("canvas");
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const ctx = canvas.getContext("2d")!;
      timer = setInterval(() => {
        if (!encoder || !client.canSendFrame) return;
        const t = Date.now();
        drawMirroredFrame(ctx, video);
        encoder.encode(canvas, t);
      }, 1000 / SEND_FPS);
    })().catch((e) => setPhase({ kind: "error", message: String(e) }));

    const stats = setInterval(() => {
      if (latencies.current.length) setLatency(median(latencies.current));
      const client = clientRef.current;
      if (!client) return;
      const { up, down } = client.takeTraffic();
      setNet({ rtt: client.rttMs, upMbit: (up * 8) / 1e6, downMbit: (down * 8) / 1e6, fps: shownFrames.current });
      shownFrames.current = 0;
    }, 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
      clearInterval(stats);
      closePlayer();
      clientRef.current?.close();
      clientRef.current = null;
      setConnected(false);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [server, attempt]);

  useEffect(() => {
    if (!connected || !product) return;
    let cancelled = false;
    loadProductImage(product)
      .then((refImage) => !cancelled && clientRef.current?.start({ prompt, refImage }))
      .catch((e) => setPhase({ kind: "error", message: `Couldn't load the product photo (${e}). Try picking another image.` }));
    latencies.current = [];
    setLatency(null);
    return () => {
      cancelled = true;
    };
  }, [connected, product, prompt]);

  function snapshot() {
    outRef.current?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `toshoyna-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setToast("Saved to Downloads");
      setTimeout(() => setToast(null), 2000);
    }, "image/png");
  }

  const live = phase.kind === "live";
  const stopped = phase.kind === "closed" || phase.kind === "error";
  const garment = product ? (product.name.split(" | ").map(garmentNoun).find(Boolean) ?? "clothes") : null;

  return (
    <main className="flex h-screen flex-col bg-zinc-950 font-sans text-white select-none">
      <header className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <img src="/icons/icon32.png" alt="" className="h-5 w-5" />
          <span className="text-sm font-semibold tracking-wide">Toshoyna</span>
        </div>
        <button
          onClick={() => setShowStats((v) => !v)}
          title="Show connection details"
          className="flex items-center gap-2 rounded-full bg-white/10 px-2.5 py-0.5 font-mono text-[11px] hover:bg-white/15"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : stopped ? "bg-red-400" : "bg-amber-400"}`} />
          {live && latency !== null ? `${(latency / 1000).toFixed(1)}s delay` : live ? "live" : stopped ? "stopped" : "starting"}
        </button>
      </header>

      <div className="relative mx-2 flex-1 overflow-hidden rounded-2xl bg-black">
        <canvas
          ref={outRef}
          width={FRAME_WIDTH}
          height={FRAME_HEIGHT}
          aria-label="You, wearing the product"
          className={`h-full w-full object-contain ${hasOutput ? "" : "invisible"}`}
        />
        <video ref={videoRef} muted playsInline className="hidden" />

        {(!hasOutput || stopped) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70 p-8 text-center">
            {!stopped && product && <Spinner />}
            <p className="text-sm leading-relaxed text-zinc-300">{statusText(phase, product)}</p>
            {stopped && (
              <button onClick={() => setAttempt((n) => n + 1)} className="rounded-full bg-amber-400 px-4 py-1.5 text-sm font-medium text-black hover:bg-amber-300">
                Try again
              </button>
            )}
          </div>
        )}

        {hasOutput && phase.kind === "starting" && (
          <div className="absolute inset-x-0 top-3 flex justify-center">
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs">
              <Spinner small /> Switching to the {garment}…
            </span>
          </div>
        )}

        {showStats && live && net && (
          <div className="absolute right-2 top-2 rounded-lg bg-black/70 px-2 py-1 font-mono text-[10px] leading-relaxed text-zinc-300">
            <div>delay {latency !== null ? Math.round(latency) : "–"} ms</div>
            <div>ping {net.rtt ?? "–"} ms</div>
            <div>
              ↑{net.upMbit.toFixed(1)} ↓{net.downMbit.toFixed(1)} Mbit/s
            </div>
            <div>{net.fps} fps</div>
          </div>
        )}

        {toast && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
            <span className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-black">{toast}</span>
          </div>
        )}
      </div>

      <footer className="flex items-center gap-3 px-3 py-2">
        {product ? (
          <img
            src={product.shownSrc}
            alt={product.alt || "Selected product"}
            title={product.name}
            className="h-11 w-11 shrink-0 rounded-lg bg-white object-contain"
          />
        ) : (
          <div className="h-11 w-11 shrink-0 rounded-lg bg-white/10" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{product?.alt || product?.name.split(" | ")[0] || "No product yet"}</div>
          <div className="truncate text-xs text-zinc-500">{product ? `Trying on: ${garment}` : "Pick one from a shop page"}</div>
        </div>
        <IconButton label="Save a photo" disabled={!hasOutput} onClick={snapshot}>
          <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
          <circle cx="12" cy="13" r="3.5" />
        </IconButton>
        <IconButton label="Settings" onClick={() => setShowSettings((v) => !v)}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
        </IconButton>
      </footer>

      {showSettings && server && (
        <form
          className="space-y-2 border-t border-white/10 p-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const text = String(form.get("prompt")).trim();
            setCustomPrompt(text && text !== instructionFor(product?.name ?? "") ? text : null);
            const url = String(form.get("url")).trim().replace(/\/+$/, "");
            if (url !== server) {
              chrome.storage.local.set({ serverUrl: url });
              setServer(url);
            }
            setShowSettings(false);
          }}
        >
          <label className="block">
            <span className="text-zinc-400">Instruction</span>
            <textarea
              name="prompt"
              defaultValue={prompt}
              rows={2}
              className="mt-1 w-full resize-none rounded bg-zinc-900 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-amber-400"
            />
          </label>
          <label className="block">
            <span className="text-zinc-400">Server</span>
            <input name="url" defaultValue={server} className="mt-1 w-full rounded bg-zinc-900 px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-amber-400" />
          </label>
          <div className="flex justify-end gap-2">
            {customPrompt !== null && (
              <button type="button" onClick={() => setCustomPrompt(null)} className="rounded px-2 py-1 text-zinc-400 hover:text-white">
                Automatic instruction
              </button>
            )}
            <button className="rounded bg-amber-400 px-3 py-1 font-medium text-black hover:bg-amber-300">Save</button>
          </div>
        </form>
      )}
    </main>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  return <span className={`${small ? "h-3 w-3 border-2" : "h-8 w-8 border-[3px]"} animate-spin rounded-full border-white/20 border-t-amber-400`} />;
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-full p-2 text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
        {children}
      </svg>
    </button>
  );
}

function statusText(phase: Phase, product: Product | null) {
  if (!product) return "Click the Toshoyna icon on a shop page, then click a product photo.";
  switch (phase.kind) {
    case "waking":
      return phase.seconds < 10 ? "Waking up the mirror…" : `Waking up the mirror… ${phase.seconds}s. After a break this takes about 2 minutes.`;
    case "camera":
      return "Allow camera access to see yourself in the mirror.";
    case "connecting":
      return "Connecting…";
    case "queued":
      return `Someone else is using the mirror. You're next after ${phase.ahead}.`;
    case "starting":
    case "live":
      return "Dressing you up… stand back so your upper body is in view.";
    case "closed":
      return `The mirror stopped: ${phase.reason}.`;
    case "error":
      return phase.message;
  }
}
