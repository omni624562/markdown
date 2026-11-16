/**
 * 網頁檔（.html、.htm）的預覽：狀態列有原始碼、分割、預覽；預覽照網頁本身的樣子顯示（iframe，不執行腳本）。
 * 其他程式碼檔（.css 等）只有原始碼。`<link>`（含 preconnect、dns-prefetch）全部拿掉，也關掉 DNS 預先查詢：
 * 這些不受 CSP 管，一打開別人給的網頁檔就會連到對方的伺服器。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { open } from "./helpers.mjs";

const HTML = "<!doctype html><html><head><title>報價單</title><style>h1 { color: rgb(200, 0, 0); }</style></head>\n<body><h1>Contoso 報價單</h1><p>聯絡人：王小明</p></body></html>";
const FILE = { kind: "file", path: "/notes/報價單.html", name: "報價單.html", text: HTML, encoding: "utf-8" };

const shownViews = (page) => page.$$eval(".view-switch:not([hidden]) [data-view]:not([hidden])", (bs) => bs.map((b) => b.dataset.view));

test("網頁檔：狀態列有原始碼、分割、預覽；預覽照網頁本身的樣子顯示", async () => {
  const { page, context, errors } = await open({ desktop: { startup_target: FILE } });
  await page.locator("#tab-bar .tab", { hasText: "報價單.html" }).waitFor();
  // 網頁檔沒有即時預覽：等狀態列換成這份文件的模式。
  await page.locator('.view-switch [data-view="live"]').waitFor({ state: "hidden" });
  assert.deepEqual(await shownViews(page), ["editor", "split", "preview"]);
  await page.locator('button[data-view="preview"]').click();
  const h1 = page.frameLocator("iframe.html-preview").locator("h1", { hasText: "Contoso 報價單" });
  await h1.waitFor();
  // 網頁自己的樣式照樣套用。
  assert.equal(await h1.evaluate((el) => getComputedStyle(el).color), "rgb(200, 0, 0)");
  // 指令面板也有同樣的模式。
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill("分割");
  await page.locator("dialog[open] [role=option]").first().waitFor();
  assert.ok((await page.locator("dialog[open] [role=option] .palette-title").allTextContents()).some((t) => /分割/.test(t)));
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await context.close();
});

test("其他程式碼檔（.css）只有原始碼，狀態列不顯示檢視切換", async () => {
  const css = { kind: "file", path: "/notes/style.css", name: "style.css", text: "h1 { color: red; }\n", encoding: "utf-8" };
  const { page, context, errors } = await open({ desktop: { startup_target: css } });
  await page.locator("#tab-bar .tab", { hasText: "style.css" }).waitFor();
  await page.locator(".view-switch").waitFor({ state: "hidden" });
  assert.deepEqual(await shownViews(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test("網頁檔的預覽：拿掉 <link>（preconnect、dns-prefetch、外部 CSS）與腳本，關掉 DNS 預先查詢，不連到外面", async () => {
  const source = [
    "<!doctype html><html><head>",
    '<link rel="preconnect" href="https://evil.test">',
    '<link rel="dns-prefetch" href="https://evil.test">',
    '<link rel="stylesheet" href="https://evil.test/a.css">',
    "<title>報價單</title></head>",
    "<body><h1>Contoso 報價單</h1><script>document.title = 'x'</script></body></html>",
  ].join("\n");
  const file = { ...FILE, text: source };
  const { page, context, errors, external } = await open({ desktop: { startup_target: file } });
  await page.locator('.view-switch [data-view="live"]').waitFor({ state: "hidden" });
  await page.locator('button[data-view="preview"]').click();
  await page.frameLocator("iframe.html-preview").locator("h1", { hasText: "Contoso 報價單" }).waitFor();
  const srcdoc = await page.locator("iframe.html-preview").getAttribute("srcdoc");
  assert.doesNotMatch(srcdoc, /<link\b/i, "沒有 <link>");
  assert.doesNotMatch(srcdoc, /<script\b/i, "沒有 <script>");
  assert.match(srcdoc, /<meta http-equiv="x-dns-prefetch-control" content="off">/);
  await page.waitForTimeout(300);
  assert.deepEqual(external.filter((u) => u.includes("evil.test")), [], "沒有連到對方的伺服器");
  assert.deepEqual(errors, []);
  await context.close();
});

test("網頁比預覽區寬（固定寬度的簡報）：整頁縮小到看得到全寬；一般的網頁、跟著寬度變大的網頁照原樣", async () => {
  const deck =
    '<!doctype html><html><head><style>body { margin: 0; } .slide { width: 1920px; height: 1080px; background: #103; color: #fff; font-size: 150px; white-space: nowrap; }</style></head>' +
    '<body><div class="slide">從需求到可驗證交付<span id="end" style="float:right">尾</span></div></body></html>';
  const { page, context, errors } = await open({ desktop: { startup_target: { kind: "file", path: "/notes/簡報.html", name: "簡報.html", text: deck, encoding: "utf-8" } } });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.locator("#tab-bar .tab", { hasText: "簡報.html" }).waitFor();
  await page.locator('button[data-view="preview"]').click();
  const frame = page.locator("iframe.html-preview");
  await page.frameLocator("iframe.html-preview").locator("#end").waitFor();
  await page.waitForFunction(() => !!document.querySelector("iframe.html-preview").dataset.scale);
  const fit = await frame.evaluate((el) => {
    const pane = el.parentElement.getBoundingClientRect();
    const shown = el.getBoundingClientRect();
    const end = el.contentDocument.querySelector("#end").getBoundingClientRect();
    const scale = Number(el.dataset.scale);
    return { scale, paneWidth: pane.width, shownWidth: shown.width, endRight: end.right * scale, inner: el.contentWindow.innerWidth, scrollX: el.parentElement.scrollWidth - el.parentElement.clientWidth };
  });
  assert.ok(fit.scale < 1 && fit.scale > 0.25, JSON.stringify(fit));
  assert.ok(Math.abs(fit.shownWidth - fit.paneWidth) <= 4, `縮小之後剛好是預覽區的寬度：${JSON.stringify(fit)}`);
  assert.ok(fit.endRight <= fit.paneWidth + 1, `最右邊的字看得到：${JSON.stringify(fit)}`);
  assert.ok(fit.inner >= 1900, `網頁裡看到的寬度是它需要的寬度：${JSON.stringify(fit)}`);
  assert.ok(fit.scrollX <= 1, `預覽區不會多出橫向捲軸：${JSON.stringify(fit)}`);
  // 視窗變寬到裝得下：恢復原樣。
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.waitForFunction(() => !document.querySelector("iframe.html-preview").dataset.scale);

  // 一般（會跟著寬度排版）的網頁不縮；怎麼放大都裝不下的（用 vw）也照原樣。
  await page.setViewportSize({ width: 1000, height: 700 });
  for (const html of [HTML, '<!doctype html><html><body style="margin:0"><div style="width:150vw;height:50px">很寬</div></body></html>']) {
    await page.evaluate((text) => {
      const content = document.querySelector(".cm-content");
      const tile = content.cmView ?? content.cmTile;
      const view = tile.view ?? tile.root.view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }, html);
    await page.waitForFunction((text) => document.querySelector("iframe.html-preview").srcdoc.includes(text.slice(-40)), html);
    await page.waitForTimeout(300);
    assert.equal(await frame.evaluate((el) => el.dataset.scale ?? ""), "", html.slice(0, 60));
  }
  assert.deepEqual(errors, []);
  await context.close();
});
