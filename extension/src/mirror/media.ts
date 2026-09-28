export type FrameSize = { width: number; height: number };

// The two sizes JoyAI serves (its warmup compiles both). The mirror follows the window's shape so the
// picture fills it: landscape when maximized, portrait in a tall window.
const LANDSCAPE: FrameSize = { width: 840, height: 480 };
const PORTRAIT: FrameSize = { width: 480, height: 840 };

export function frameSizeFor(viewWidth: number, viewHeight: number): FrameSize {
  return viewWidth >= viewHeight ? LANDSCAPE : PORTRAIT;
}
const REF_MAX_SIDE = 1024;

/** Product photo as a data URL. The extension's host permission lets it fetch from any shop without CORS. */
export async function loadRefImage(src: string): Promise<string> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`product image HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, REF_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Center-crops the camera to the canvas size and mirrors it, as JoyAI's own client does. */
export function drawMirroredFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const { width, height } = ctx.canvas;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const target = width / height;
  let sw = vw;
  let sh = vh;
  if (vw / vh > target) sw = vh * target;
  else sh = vw / target;
  ctx.setTransform(-1, 0, 0, 1, width, 0);
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
