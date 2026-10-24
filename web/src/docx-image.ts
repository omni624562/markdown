/**
 * 匯出 Word 用的圖片：讀取並取得大小，Word 不支援的格式（WebP、SVG 等）先畫成 PNG。
 * 網頁版（docx-export.ts）和桌面版（後端產生 .docx）共用。
 */

export interface DocxImage {
  data: Uint8Array;
  type: "png" | "jpg" | "gif" | "bmp";
  width: number;
  height: number;
}

/** 讀取圖片：PNG、JPEG、GIF、BMP 直接使用，其他格式（WebP、SVG 等）先畫成 PNG。 */
export async function loadImage(url: string): Promise<DocxImage | null> {
  const blob = await (await fetch(url)).blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    const width = img.naturalWidth || 300;
    const height = img.naturalHeight || 200;
    const native: Record<string, DocxImage["type"]> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/bmp": "bmp",
    };
    const type = native[blob.type];
    if (type) return { data: new Uint8Array(await blob.arrayBuffer()), type, width, height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return png ? { data: new Uint8Array(await png.arrayBuffer()), type: "png", width, height } : null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
