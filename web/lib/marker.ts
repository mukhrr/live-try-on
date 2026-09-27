// Frame-id stamp painted into pixels. Must stay in sync with server/marker.py.

const SYNC = [1, 0];
const ID_BITS = 16;
const BLOCKS = SYNC.length + ID_BITS;
export const ID_MOD = 1 << ID_BITS;

function blockRect(i: number, w: number, h: number) {
  const bw = Math.max(1, Math.round(w / 32));
  const bh = Math.max(1, Math.round(h / 24));
  return { x: i * bw, y: 0, w: bw, h: bh };
}

export function stripHeight(h: number) {
  return Math.max(1, Math.round(h / 24));
}

export function write(ctx: CanvasRenderingContext2D, w: number, h: number, id: number) {
  const bits = [...SYNC];
  for (let k = ID_BITS - 1; k >= 0; k--) bits.push((id >> k) & 1);
  bits.forEach((b, i) => {
    const r = blockRect(i, w, h);
    ctx.fillStyle = b ? "#fff" : "#000";
    ctx.fillRect(r.x, r.y, r.w, r.h);
  });
}

// `data` is the RGBA top strip of a w x h frame, as returned by getImageData(0, 0, w, stripHeight(h)).
export function read(data: Uint8ClampedArray, w: number, h: number): number | null {
  let value = 0;
  for (let i = 0; i < BLOCKS; i++) {
    const r = blockRect(i, w, h);
    const cx = Math.floor(r.x + r.w / 2);
    const cy = Math.floor(r.y + r.h / 2);
    const dx = Math.max(1, Math.floor(r.w / 4));
    const dy = Math.max(1, Math.floor(r.h / 4));
    let sum = 0;
    let n = 0;
    for (let y = cy - dy; y < cy + dy; y++) {
      for (let x = cx - dx; x < cx + dx; x++) {
        const p = (y * w + x) * 4;
        sum += data[p] + data[p + 1] + data[p + 2];
        n += 3;
      }
    }
    const bit = sum / n > 127 ? 1 : 0;
    if (i < SYNC.length) {
      if (bit !== SYNC[i]) return null;
    } else {
      value = (value << 1) | bit;
    }
  }
  return value;
}
