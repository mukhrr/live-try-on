// The offscreen engine can't show Chrome's camera prompt, so this visible page asks once for the extension.
import { BUS_NAME, type ViewerMessage } from "./bus";

const msg = document.getElementById("msg")!;
navigator.mediaDevices
  .getUserMedia({ video: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    new BroadcastChannel(BUS_NAME).postMessage({ from: "permission", type: "camera-granted" } satisfies ViewerMessage);
    msg.textContent = "Thanks! You can close this window.";
    setTimeout(() => window.close(), 600);
  })
  .catch(() => {
    msg.textContent = "Camera access was blocked. Allow it from the camera icon in the address bar, then reload this window.";
  });
