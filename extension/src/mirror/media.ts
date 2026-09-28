// Portrait, like a mirror: more of the body and garment fits. JoyAI serves 480x840 natively (its warmup compiles it).
export const FRAME_WIDTH = 480;
export const FRAME_HEIGHT = 840;
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

/** Center-crops the camera to the frame size and mirrors it, as JoyAI's own client does. */
export function drawMirroredFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const target = FRAME_WIDTH / FRAME_HEIGHT;
  let sw = vw;
  let sh = vh;
  if (vw / vh > target) sw = vh * target;
  else sh = vw / target;
  ctx.setTransform(-1, 0, 0, 1, FRAME_WIDTH, 0);
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
