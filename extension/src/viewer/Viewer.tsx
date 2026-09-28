import { useEffect, useRef, useState } from "react";
import { BUS_NAME, type BusMessage, type EnginePhase, type NetStats, type ViewerMessage, type ViewerSettings } from "../bus";
import { DownlinkDecoder } from "../mirror/codec";
import { garmentNoun, instructionFor } from "../mirror/garment";
import { type FrameSize, frameSizeFor } from "../mirror/media";
import { PacedPlayer } from "../mirror/playback";
import type { Product } from "../types";

// The server has no login, so its URL is kept out of the repo: set it in extension/.env.local or under Settings.
const DEFAULT_SERVER = import.meta.env.VITE_SERVER_URL ?? "";
const LATENCY_WINDOW = 48;

type Mode = "float" | "full";

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export default function Viewer({ mode }: { mode: Mode }) {
  const outRef = useRef<HTMLCanvasElement>(null);
  const bus = useRef<BroadcastChannel | null>(null);
  const viewerId = useRef(crypto.randomUUID());
  const latencies = useRef<number[]>([]);
  const shownFrames = useRef(0);
  const settingsRef = useRef<ViewerSettings | null>(null);
  const lastEngineMsg = useRef(0);

  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [customPrompt, setCustomPrompt] = useState<string | null>(null);
  const [size, setSize] = useState<FrameSize>(() => frameSizeFor(innerWidth, innerHeight));
  const [phase, setPhase] = useState<EnginePhase>({ kind: "waking", seconds: 0 });
  const [hasOutput, setHasOutput] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [net, setNet] = useState<NetStats | null>(null);
  const [fps, setFps] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const prompt = customPrompt ?? (product ? instructionFor(product.name) : "");
  const settings: ViewerSettings | null = serverUrl ? { size, product, serverUrl, prompt: customPrompt } : null;
  const noServer = serverUrl === "";
  settingsRef.current = settings;

  // Product, server and instruction live in extension storage so the float and the full window agree.
  useEffect(() => {
    chrome.storage.local.get("serverUrl").then(({ serverUrl }) => setServerUrl((serverUrl as string) || DEFAULT_SERVER));
    chrome.storage.session.get(["product", "prompt"]).then(({ product, prompt }) => {
      if (product) setProduct(product as Product);
      setCustomPrompt((prompt as string | undefined) ?? null);
    });
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes.product?.newValue) setProduct(changes.product.newValue as Product);
      if (area === "session" && "prompt" in changes) setCustomPrompt((changes.prompt.newValue as string | undefined) ?? null);
      if (area === "local" && changes.serverUrl?.newValue) setServerUrl(changes.serverUrl.newValue as string);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => setSize((prev) => {
        const next = frameSizeFor(innerWidth, innerHeight);
        return next.width === prev.width ? prev : next;
      }), 300);
    };
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  // Downlink: decode and pace the engine's H.264 locally, so every viewer draws its own copy.
  useEffect(() => {
    const channel = new BroadcastChannel(BUS_NAME);
    bus.current = channel;
    const player = new PacedPlayer(outRef.current!.getContext("2d")!, (ms) => {
      setHasOutput(true);
      shownFrames.current += 1;
      latencies.current.push(ms);
      if (latencies.current.length > LATENCY_WINDOW) latencies.current.shift();
    });
    let decoder: DownlinkDecoder | null = null;
    const resetStream = () => {
      decoder?.close();
      decoder = null;
      player.reset();
      latencies.current = [];
    };

    channel.onmessage = (e: MessageEvent<BusMessage>) => {
      const msg = e.data;
      if (msg.from !== "engine") return;
      lastEngineMsg.current = Date.now();
      if (msg.type === "phase") {
        setPhase(msg.phase);
        if (msg.phase.kind !== "live") resetStream();
        if (msg.phase.kind === "closed" || msg.phase.kind === "error") setHasOutput(false);
      } else if (msg.type === "frame") {
        decoder ??= new DownlinkDecoder((frame, meta) => void player.push(frame, meta.t_capture_ms));
        decoder.decode(msg.data, msg.meta);
      } else if (msg.type === "stats") {
        setNet(msg.net);
      }
    };

    const send = (m: ViewerMessage) => channel.postMessage(m);
    const heartbeat = setInterval(() => {
      // The engine re-announces every 2s. Silence means it isn't up yet (a hello was lost) or it closed.
      if (Date.now() - lastEngineMsg.current > 5000 && settingsRef.current) {
        chrome.runtime.sendMessage({ type: "ensure-engine" });
        send({ from: "viewer", type: "hello", viewerId: viewerId.current, settings: settingsRef.current });
      } else {
        send({ from: "viewer", type: "heartbeat", viewerId: viewerId.current });
      }
    }, 2000);
    const stats = setInterval(() => {
      if (latencies.current.length) setLatency(median(latencies.current));
      setFps(shownFrames.current);
      shownFrames.current = 0;
    }, 1000);
    const bye = () => send({ from: "viewer", type: "bye", viewerId: viewerId.current });
    addEventListener("pagehide", bye);
    return () => {
      bye();
      removeEventListener("pagehide", bye);
      clearInterval(heartbeat);
      clearInterval(stats);
      player.close();
      decoder?.close();
      channel.close();
    };
  }, []);

  // Uplink settings: the engine follows whichever viewer changed something last.
  const said = useRef(false);
  const settingsKey = JSON.stringify(settings);
  useEffect(() => {
    if (!settings || !bus.current) return;
    bus.current.postMessage({ from: "viewer", type: said.current ? "settings" : "hello", viewerId: viewerId.current, settings } satisfies ViewerMessage);
    said.current = true;
    // settingsKey captures every field of settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

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
  const float = mode === "float";

  const badge = (
    <button
      onClick={() => setShowStats((v) => !v)}
      title="Show connection details"
      className="flex items-center gap-2 rounded-full bg-black/60 px-2.5 py-0.5 font-mono text-[11px] hover:bg-black/80"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : stopped ? "bg-red-400" : "bg-amber-400"}`} />
      {live && latency !== null ? `${(latency / 1000).toFixed(1)}s delay` : live ? "live" : stopped ? "stopped" : "starting"}
    </button>
  );

  return (
    <main className={`flex h-screen flex-col bg-zinc-950 font-sans text-white select-none ${float ? "rounded-2xl" : ""}`}>
      {!float && (
        <header className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <img src="/icons/icon32.png" alt="" className="h-5 w-5" />
            <span className="text-sm font-semibold tracking-wide">Toshoyna</span>
            <span className="font-mono text-[10px] text-zinc-500">v{chrome.runtime.getManifest().version}</span>
          </div>
          {badge}
        </header>
      )}

      <div className={`relative flex-1 overflow-hidden bg-black ${float ? "" : "mx-2 rounded-2xl"}`}>
        <canvas
          ref={outRef}
          width={size.width}
          height={size.height}
          aria-label="You, wearing the product"
          className={`h-full w-full object-contain ${hasOutput ? "" : "invisible"}`}
        />

        {(!hasOutput || stopped) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center">
            {!stopped && !noServer && product && phase.kind !== "needs-camera" && <Spinner />}
            <p className={`leading-relaxed text-zinc-300 ${float ? "text-xs" : "text-sm"}`}>
              {noServer ? "No mirror server set. Open full screen and add it under Settings (⚙)." : statusText(phase, product)}
            </p>
            {phase.kind === "needs-camera" && (
              <PrimaryButton onClick={() => chrome.runtime.sendMessage({ type: "grant-camera" })}>Allow camera</PrimaryButton>
            )}
            {stopped && <PrimaryButton onClick={() => bus.current?.postMessage({ from: "viewer", type: "retry" } satisfies ViewerMessage)}>Try again</PrimaryButton>}
          </div>
        )}

        {hasOutput && phase.kind === "starting" && (
          <div className="absolute inset-x-0 top-3 flex justify-center">
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs">
              <Spinner small /> Switching to the {garment}…
            </span>
          </div>
        )}

        {float && (
          <div className="absolute right-2 top-2 flex items-center gap-1">
            {badge}
            <IconButton small label="Open full screen" onClick={() => chrome.runtime.sendMessage({ type: "open-full" })}>
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </IconButton>
            <IconButton small label="Close" onClick={() => parent.postMessage({ toshoyna: "close" }, "*")}>
              <path d="M6 6l12 12M18 6 6 18" />
            </IconButton>
          </div>
        )}

        {showStats && live && net && (
          <div className={`absolute right-2 rounded-lg bg-black/70 px-2 py-1 font-mono text-[10px] leading-relaxed text-zinc-300 ${float ? "top-10" : "top-2"}`}>
            <div>delay {latency !== null ? Math.round(latency) : "–"} ms</div>
            <div>ping {net.rtt ?? "–"} ms</div>
            <div>
              ↑{net.upMbit.toFixed(1)} ↓{net.downMbit.toFixed(1)} Mbit/s
            </div>
            <div>{fps} fps</div>
          </div>
        )}

        {toast && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
            <span className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-black">{toast}</span>
          </div>
        )}

        {float && (
          <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between">
            {product && (
              <img src={product.shownSrc} alt={product.alt || "Selected product"} title={product.name} className="h-10 w-10 rounded-lg bg-white object-contain" />
            )}
            <IconButton small label="Save a photo" disabled={!hasOutput} onClick={snapshot}>
              <CameraIcon />
            </IconButton>
          </div>
        )}
      </div>

      {!float && (
        <footer className="flex items-center gap-3 px-3 py-2">
          {product ? (
            <img src={product.shownSrc} alt={product.alt || "Selected product"} title={product.name} className="h-11 w-11 shrink-0 rounded-lg bg-white object-contain" />
          ) : (
            <div className="h-11 w-11 shrink-0 rounded-lg bg-white/10" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{product?.alt || product?.name.split(" | ")[0] || "No product yet"}</div>
            <div className="truncate text-xs text-zinc-500">{product ? `Trying on: ${garment}` : "Pick one from a shop page"}</div>
          </div>
          <IconButton label="Save a photo" disabled={!hasOutput} onClick={snapshot}>
            <CameraIcon />
          </IconButton>
          <IconButton label="Settings" onClick={() => setShowSettings((v) => !v)}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          </IconButton>
        </footer>
      )}

      {!float && showSettings && serverUrl !== null && (
        <form
          className="space-y-2 border-t border-white/10 p-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const text = String(form.get("prompt")).trim();
            const custom = text && text !== instructionFor(product?.name ?? "") ? text : null;
            if (custom) chrome.storage.session.set({ prompt: custom });
            else chrome.storage.session.remove("prompt");
            const url = String(form.get("url")).trim().replace(/\/+$/, "");
            if (url !== serverUrl) chrome.storage.local.set({ serverUrl: url });
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
            <input name="url" defaultValue={serverUrl} className="mt-1 w-full rounded bg-zinc-900 px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-amber-400" />
          </label>
          <div className="flex justify-end gap-2">
            {customPrompt !== null && (
              <button type="button" onClick={() => chrome.storage.session.remove("prompt")} className="rounded px-2 py-1 text-zinc-400 hover:text-white">
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

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-full bg-amber-400 px-4 py-1.5 text-sm font-medium text-black hover:bg-amber-300">
      {children}
    </button>
  );
}

function CameraIcon() {
  return (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  small = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded-full text-zinc-200 hover:text-white disabled:opacity-30 ${small ? "bg-black/60 p-1.5 hover:bg-black/80" : "p-2 hover:bg-white/10"}`}
    >
      <svg viewBox="0 0 24 24" className={small ? "h-4 w-4" : "h-5 w-5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
        {children}
      </svg>
    </button>
  );
}

function statusText(phase: EnginePhase, product: Product | null) {
  if (!product) return "Click the Toshoyna icon on a shop page, then click a product photo.";
  switch (phase.kind) {
    case "waking":
      return phase.seconds < 10 ? "Waking up the mirror…" : `Waking up the mirror… ${phase.seconds}s. After a break this takes about 2 minutes.`;
    case "camera":
      return "Turning on your camera…";
    case "needs-camera":
      return "Toshoyna needs your camera once to show you in the mirror.";
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
