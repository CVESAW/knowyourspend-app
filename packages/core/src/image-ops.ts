/**
 * Pure image operations for receipt OCR, on a single-channel (greyscale) buffer.
 * No DOM here, so the exact same code runs in the browser and in the offline evaluation harness.
 *
 * Measured on 30 synthetic UK receipt photos (clean / phone / poor): upscaling to ~1400px wide plus an
 * adaptive (local-mean) threshold lifted brand recall from 71% to 92%, mostly on poor photos.
 */

export interface Gray {
  w: number;
  h: number;
  px: Float32Array; // 0..255
}

export const TARGET_WIDTH = 1400;
export const MAX_WIDTH = 2400;

/** Width to scale a photo to before OCR: small images are enlarged (Tesseract likes ~20-30px text), huge ones reduced. */
export function targetSize(w: number, h: number): { w: number; h: number } {
  let s = 1;
  if (w < TARGET_WIDTH) s = TARGET_WIDTH / w;
  else if (w > MAX_WIDTH) s = MAX_WIDTH / w;
  // keep total pixels sane for phones (long receipts)
  const maxPixels = 12_000_000;
  if (w * s * h * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

export function rgbaToGray(data: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const px = new Float32Array(w * h);
  for (let i = 0, j = 0; j < px.length; i += 4, j++) px[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  return { w, h, px };
}

/** Stretch contrast so the 1st percentile is black and the 99th white (robust to glare and shadow). */
export function stretchContrast(g: Gray): Gray {
  const hist = new Uint32Array(256);
  for (const v of g.px) hist[Math.max(0, Math.min(255, v | 0))]!++;
  const n = g.px.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= n * 0.01) { lo = i; break; }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i]!;
    if (acc >= n * 0.01) { hi = i; break; }
  }
  const range = Math.max(1, hi - lo);
  const px = new Float32Array(n);
  for (let i = 0; i < n; i++) px[i] = Math.max(0, Math.min(255, ((g.px[i]! - lo) / range) * 255));
  return { w: g.w, h: g.h, px };
}

/**
 * Adaptive threshold: a pixel is ink if it's darker than its neighbourhood mean by `offset`.
 * Handles uneven lighting and faded thermal print far better than a single global threshold.
 * O(n) via an integral image.
 */
export function adaptiveThreshold(g: Gray, radius = Math.max(8, Math.round(g.w / 40)), offset = 10): Gray {
  const { w, h } = g;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += g.px[(y - 1) * w + (x - 1)]!;
      I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x]! + row;
    }
  }
  const px = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const sum = I[y1 * (w + 1) + x1]! - I[y0 * (w + 1) + x1]! - I[y1 * (w + 1) + x0]! + I[y0 * (w + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      px[y * w + x] = g.px[y * w + x]! < mean - offset ? 0 : 255;
    }
  }
  return { w, h, px };
}

export function grayToRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h * 4);
  for (let i = 0, j = 0; i < g.px.length; i++, j += 4) {
    const v = g.px[i]!;
    out[j] = out[j + 1] = out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Find the receipt paper in a photo and return its bounding box (in `g` coordinates), or null.
 * Paper is the largest bright region: Otsu-threshold a downsampled copy, keep the largest bright
 * connected component, take its bounding box with a small margin. Cropping away the table/background
 * stops wood grain and shadows turning into junk "words" around every line.
 */
export function findPaper(g: Gray): { x: number; y: number; w: number; h: number } | null {
  const f = Math.max(1, Math.round(Math.max(g.w, g.h) / 300));
  const sw = Math.floor(g.w / f), sh = Math.floor(g.h / f);
  if (sw < 20 || sh < 20) return null;
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += g.px[(y * f + dy) * g.w + (x * f + dx)]!;
    small[y * sw + x] = s / (f * f);
  }
  // Otsu
  const hist = new Float64Array(256);
  for (const v of small) hist[Math.max(0, Math.min(255, v | 0))]!++;
  const total = small.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  // bright mask, closed a little so text doesn't split the paper into pieces
  const mask = new Uint8Array(sw * sh);
  for (let i = 0; i < mask.length; i++) mask[i] = small[i]! > thr ? 1 : 0;
  const closed = new Uint8Array(sw * sh);
  const r = 2;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let on = 0;
    for (let dy = -r; dy <= r && !on; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < sh && xx >= 0 && xx < sw && mask[yy * sw + xx]) { on = 1; break; }
    }
    closed[y * sw + x] = on;
  }
  // largest component (4-connected, iterative flood fill)
  const label = new Int32Array(sw * sh);
  let bestSize = 0, bestBox = { x0: 0, y0: 0, x1: 0, y1: 0 }, next = 1;
  const stack: number[] = [];
  for (let i = 0; i < closed.length; i++) {
    if (!closed[i] || label[i]) continue;
    let size = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % sw, py = (p / sw) | 0;
      size++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const q of [p - 1, p + 1, p - sw, p + sw]) {
        if (q < 0 || q >= closed.length) continue;
        if ((q === p - 1 && px === 0) || (q === p + 1 && px === sw - 1)) continue;
        if (closed[q] && !label[q]) { label[q] = next; stack.push(q); }
      }
    }
    if (size > bestSize) { bestSize = size; bestBox = { x0, y0, x1, y1 }; }
    next++;
  }
  const area = bestSize / total;
  if (area < 0.12 || area > 0.97) return null; // no clear paper, or the paper already fills the frame
  const m = 0.02;
  const x = Math.max(0, Math.floor((bestBox.x0 / sw - m) * g.w));
  const y = Math.max(0, Math.floor((bestBox.y0 / sh - m) * g.h));
  const x2 = Math.min(g.w, Math.ceil(((bestBox.x1 + 1) / sw + m) * g.w));
  const y2 = Math.min(g.h, Math.ceil(((bestBox.y1 + 1) / sh + m) * g.h));
  const w = x2 - x, h = y2 - y;
  if (w < g.w * 0.15 || h < g.h * 0.15) return null;
  return { x, y, w, h };
}

export function crop(g: Gray, b: { x: number; y: number; w: number; h: number }): Gray {
  const px = new Float32Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) px.set(g.px.subarray((b.y + y) * g.w + b.x, (b.y + y) * g.w + b.x + b.w), y * b.w);
  return { w: b.w, h: b.h, px };
}

export function resizeGray(g: Gray, w: number, h: number): Gray {
  if (w === g.w && h === g.h) return g;
  const px = new Float32Array(w * h);
  const sxr = g.w / w, syr = g.h / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, (y + 0.5) * syr - 0.5);
    const y0 = Math.min(g.h - 1, Math.floor(sy)), y1 = Math.min(g.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, (x + 0.5) * sxr - 0.5);
      const x0 = Math.min(g.w - 1, Math.floor(sx)), x1 = Math.min(g.w - 1, x0 + 1), fx = sx - x0;
      const a = g.px[y0 * g.w + x0]!, b = g.px[y0 * g.w + x1]!, c = g.px[y1 * g.w + x0]!, d = g.px[y1 * g.w + x1]!;
      px[y * w + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return { w, h, px };
}

export type Variant = "binary" | "soft";

/** The whole on-device preparation: find & crop the paper, resize for OCR, stretch contrast, threshold. */
export function prepareForOcr(g: Gray, variant: Variant): Gray {
  const box = findPaper(g);
  let out = box ? crop(g, box) : g;
  const t = targetSize(out.w, out.h);
  out = resizeGray(out, t.w, t.h);
  out = stretchContrast(out);
  if (variant === "binary") out = adaptiveThreshold(out);
  return out;
}

/** Working resolution for the first decode (before cropping): long side capped to keep phones fast. */
export function workingSize(w: number, h: number, maxSide = 2600): { w: number; h: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}
