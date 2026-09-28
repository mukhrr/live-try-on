import type { Product } from "./types";

type Message = { type: "picked"; product: Product } | { type: "open-full" } | { type: "grant-camera" } | { type: "ensure-engine" };

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (e) {
    // chrome:// pages, the Web Store and PDF viewers refuse injection.
    console.warn("Toshoyna: can't pick on this page", e);
  }
});

chrome.runtime.onMessage.addListener((msg: Message) => {
  switch (msg.type) {
    case "picked":
      // Viewers watch this key, so an open mirror switches garment without reloading.
      void chrome.storage.session.set({ product: msg.product }).then(ensureEngine);
      break;
    case "open-full":
      void ensureEngine().then(openFullMirror);
      break;
    case "grant-camera":
      void chrome.windows.create({ url: chrome.runtime.getURL("permission.html"), type: "popup", width: 420, height: 260, focused: true });
      break;
    case "ensure-engine":
      void ensureEngine();
      break;
  }
});

let creating: Promise<void> | null = null;

/** The engine is an offscreen document: the only place a service-worker extension can hold a camera. */
async function ensureEngine() {
  if (await chrome.offscreen.hasDocument()) return;
  // Two viewers asking at once would otherwise both try to create it, and the second call throws.
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Streams the webcam to the try-on server for the Toshoyna mirror.",
    })
    .finally(() => (creating = null));
  await creating;
}

async function openFullMirror() {
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
    state: "maximized",
    focused: true,
  });
  await chrome.storage.session.set({ mirrorWindowId: win?.id });
}
