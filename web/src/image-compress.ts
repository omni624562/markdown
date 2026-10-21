/**
 * 貼上或拖進很大的圖片時自動縮小並壓縮：寬或高超過 2000 像素的縮到 2000 像素，
 * 檔案還是很大、而且沒有透明部分的（通常是照片）改存成 JPEG。螢幕截圖維持 PNG，文字才清楚。
 * GIF（可能是動畫）與 SVG 不處理；壓縮後沒有比較小就用原檔。
 */

export const MAX_SIDE = 2000;
/** 超過這個大小才考慮重新壓縮或改成 JPEG。 */
export const LARGE_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.86;

export interface ImageInfo {
  type: string;
  size: number;
  width: number;
  height: number;
}

/** 要不要處理、縮放比例。 */
export function planCompression(info: ImageInfo): { scale: number; reencode: boolean } {
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(info.type)) return { scale: 1, reencode: false };
  const longest = Math.max(info.width, info.height);
  const scale = longest > MAX_SIDE ? MAX_SIDE / longest : 1;
  return { scale, reencode: scale < 1 || info.size > LARGE_BYTES };
}

/** 依類型換副檔名：`截圖.png` → `截圖.jpg`。 */
export function renameForType(name: string, type: string): string {
  const ext = type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "png");
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, `.${ext}`) : `${name}.${ext}`;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 圖片有沒有透明的部分（縮小到 64×64 取樣）。 */
function hasAlpha(source: CanvasImageSource): boolean {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(source, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

export interface Compressed {
  file: File;
  /** 有縮小或重新壓縮。 */
  changed: boolean;
  before: number;
}

export async function compressImage(file: File): Promise<Compressed> {
  const keep = { file, changed: false, before: file.size };
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(file.type)) return keep;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return keep;
  }
  try {
    const plan = planCompression({ type: file.type, size: file.size, width: bitmap.width, height: bitmap.height });
    if (!plan.reencode) return keep;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * plan.scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * plan.scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return keep;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null;
    if (file.type === "image/jpeg") blob = await toBlob(canvas, "image/jpeg", JPEG_QUALITY);
    else {
      blob = await toBlob(canvas, "image/png");
      // 很大的 PNG 又沒有透明部分（多半是照片）：改成 JPEG。
      if (blob && blob.size > LARGE_BYTES && !hasAlpha(canvas)) blob = await toBlob(canvas, "image/jpeg", JPEG_QUALITY);
    }
    if (!blob || blob.size >= file.size) return keep;
    return { file: new File([blob], renameForType(file.name, blob.type), { type: blob.type }), changed: true, before: file.size };
  } finally {
    bitmap.close();
  }
}

/** `1536000` → `1.5 MB`。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
