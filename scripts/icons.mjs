// 從 desktop/icons/icon.svg、icon-small.svg 產生桌面版與網頁版的各尺寸圖示（PNG、ICO）。
// 需要 Playwright（用 Chromium 繪製 SVG）：PW=<playwright 套件路徑> node scripts/icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "desktop/icons");
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? "playwright");

const big = readFileSync(join(icons, "icon.svg"), "utf8");
const small = readFileSync(join(icons, "icon-small.svg"), "utf8");
// iPhone 主畫面圖示會自己加圓角：底色填滿整個正方形，不留透明邊。
const fullBleed = big.replace('viewBox="0 0 512 512"', 'viewBox="32 32 448 448"').replace('rx="112"', 'rx="0"');

const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${url}" width="${size}" height="${size}">`);
  await page.waitForFunction(() => document.images[0].complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** 內含 PNG 的 ICO（Windows Vista 以後都支援）。 */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) images.push({ size, data: await png(size <= 32 ? small : big, size) });
const bySize = (s) => images.find((i) => i.size === s).data;
writeFileSync(join(icons, "icon.ico"), ico(images));
writeFileSync(join(icons, "32x32.png"), bySize(32));
writeFileSync(join(icons, "128x128.png"), bySize(128));
writeFileSync(join(icons, "128x128@2x.png"), bySize(256));
writeFileSync(join(icons, "icon.png"), await png(big, 512));
writeFileSync(join(root, "web/public/favicon.svg"), small);
writeFileSync(join(root, "web/public/apple-touch-icon.png"), await png(fullBleed, 180));
await browser.close();
console.log("已產生圖示：desktop/icons/*.png、icon.ico、web/public/favicon.svg、apple-touch-icon.png");
