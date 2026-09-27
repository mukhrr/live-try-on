import type { Product } from "./types";

const MIRROR_WIDTH = 560;
const MIRROR_HEIGHT = 440;

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (e) {
    // chrome:// pages, the Web Store and PDF viewers refuse injection.
    console.warn("Toshoyna: can't pick on this page", e);
  }
});

chrome.runtime.onMessage.addListener((msg: { type: string; product?: Product }) => {
  if (msg.type === "picked" && msg.product) void openMirror(msg.product);
});

async function openMirror(product: Product) {
  // The mirror page watches this key, so an open mirror switches garment without reloading.
  await chrome.storage.session.set({ product });

  const { mirrorWindowId } = await chrome.storage.session.get("mirrorWindowId");
  if (typeof mirrorWindowId === "number") {
    try {
      await chrome.windows.update(mirrorWindowId, { focused: true });
      return;
    } catch {
      // Closed since; fall through and open a new one.
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("mirror.html"),
    type: "popup",
    width: MIRROR_WIDTH,
    height: MIRROR_HEIGHT,
    focused: true,
  });
  await chrome.storage.session.set({ mirrorWindowId: win?.id });
}
