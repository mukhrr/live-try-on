// Injected on demand by the toolbar button. Kept import-free: executeScript runs it as a classic script.

type PickWindow = Window & { __toshoynaStopPick?: () => void };

const MIN_SIZE = 80;

function pickableImage(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  const img = target instanceof HTMLImageElement ? target : target.closest("picture")?.querySelector("img");
  if (!img) return null;
  const r = img.getBoundingClientRect();
  return r.width >= MIN_SIZE && r.height >= MIN_SIZE && (img.currentSrc || img.src) ? img : null;
}

function startPick() {
  const w = window as PickWindow;
  w.__toshoynaStopPick?.();

  const highlight = document.createElement("div");
  highlight.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #f5b400;border-radius:8px;" +
    "box-shadow:0 0 0 9999px rgba(0,0,0,.35);transition:all .08s;display:none";
  const banner = document.createElement("div");
  banner.textContent = "Toshoyna: click a product photo to try it on · Esc to cancel";
  banner.style.cssText =
    "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;" +
    "font:500 14px system-ui,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 4px 20px rgba(0,0,0,.3)";
  document.documentElement.append(highlight, banner);

  let current: HTMLImageElement | null = null;

  const onMove = (e: MouseEvent) => {
    current = pickableImage(e.target);
    if (!current) {
      highlight.style.display = "none";
      return;
    }
    const r = current.getBoundingClientRect();
    Object.assign(highlight.style, {
      display: "block",
      left: `${r.left - 3}px`,
      top: `${r.top - 3}px`,
      width: `${r.width + 6}px`,
      height: `${r.height + 6}px`,
    });
  };

  // Capture phase and swallow the click so the shop's own link or gallery doesn't fire.
  const onClick = (e: MouseEvent) => {
    const img = pickableImage(e.target);
    if (!img) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({
      type: "picked",
      product: { src: img.currentSrc || img.src, alt: img.alt.trim(), pageUrl: location.href },
    });
    stop();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") stop();
  };

  function stop() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    highlight.remove();
    banner.remove();
    delete w.__toshoynaStopPick;
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  w.__toshoynaStopPick = stop;
}

startPick();
