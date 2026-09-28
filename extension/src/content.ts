// Injected on demand by the toolbar button. Kept import-free: executeScript runs it as a classic script.

type PickWindow = Window & { __toshoynaStopPick?: () => void };

const MIN_SIZE = 80;
const IMAGE_URL = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
// Attributes shops use for the full-size or not-yet-loaded image.
const HIRES_ATTRS = ["data-zoom-image", "data-zoom-src", "data-large-image", "data-old-hires", "data-full", "data-src"];

function largestSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: { url: string; w: number } | null = null;
  for (const part of srcset.split(",")) {
    const [url, size = "1x"] = part.trim().split(/\s+/);
    const w = parseFloat(size) * (size.endsWith("x") ? 1000 : 1);
    if (url && (!best || w > best.w)) best = { url, w };
  }
  return best ? new URL(best.url, location.href).href : null;
}

/** The sharpest version of a product photo the page offers; the model sees garment detail from it. */
function bestImageUrl(img: HTMLImageElement): string {
  for (const attr of HIRES_ATTRS) {
    const v = img.getAttribute(attr);
    if (v && !v.startsWith("data:")) return new URL(v, location.href).href;
  }
  const link = img.closest("a")?.href;
  if (link && IMAGE_URL.test(link)) return link;
  const sources = [img.getAttribute("srcset"), ...Array.from(img.closest("picture")?.querySelectorAll("source") ?? [], (s) => s.getAttribute("srcset"))];
  for (const srcset of sources) {
    const url = largestSrcset(srcset);
    if (url) return url;
  }
  return img.currentSrc || img.src;
}

/** Text that names the product, most specific first, for phrasing the try-on instruction. */
function productName(img: HTMLImageElement): string {
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
  const h1 = document.querySelector("h1")?.textContent;
  const parts = [img.alt, img.title, og, h1, document.title].map((t) => t?.trim()).filter(Boolean);
  return [...new Set(parts)].join(" | ").slice(0, 300);
}

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
      product: {
        src: bestImageUrl(img),
        shownSrc: img.currentSrc || img.src,
        alt: img.alt.trim(),
        name: productName(img),
        pageUrl: location.href,
      },
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
