/**
 * 端對端測試共用的工具：用 Playwright 開啟建置好的 dist/。
 *
 * 不啟動伺服器：攔截瀏覽器的請求，直接回應 dist/ 裡的檔案；其他網址一律擋掉（也確認不會連到外部）。
 * `open({ desktop })` 會在頁面載入前放一個假的 Tauri 介面（`window.__TAURI__`），用來測試桌面版才有的畫面：
 * 原生指令的回應由 `desktop` 決定（也可以用 `{ $by: 參數名稱, values }` 依參數回應），呼叫過的指令與參數記在 `window.__fake.calls`，
 * 測試可以用 `window.__fake.emit(事件, 內容)` 模擬原生端送來的事件。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ORIGIN = "http://omarker.test";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

let browser;
before(async () => {
  assert.ok(existsSync(join(DIST, "index.html")), "請先執行 npm run build");
  browser = await chromium.launch();
});
after(() => browser?.close());

/** 假的原生端：啟動時一定會呼叫的指令先給合理的預設值，其餘回傳 null。 */
function fakeTauri(respond) {
  const DEFAULTS = {
    ai_tools: { claude: null, codex: null },
    app_version: { version: "0.0.0", build: null, commit: null, updatable: false },
    projects_list: [],
    dav_connections: [],
    term_layout: false,
    custom_title_bar: false,
    recent: { files: [], folders: [] },
    list_fonts: [],
  };
  const listeners = new Map();
  const calls = [];
  // 每個指令可以有一串回應（依序用掉，最後一個重複用）。
  const queues = new Map(Object.entries(respond).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  window.__fake = {
    calls,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn({ payload });
    },
  };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        calls.push({ cmd, args: args ?? null });
        const queue = queues.get(cmd);
        if (!queue) return cmd in DEFAULTS ? DEFAULTS[cmd] : null;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        // `{ $by: "id", values: { 42: … } }`：依參數決定回應（例如依工作項目編號）。
        if (next && typeof next === "object" && "$by" in next) return next.values[String(args?.[next.$by])] ?? null;
        return next;
        return cmd in DEFAULTS ? DEFAULTS[cmd] : null;
      },
      convertFileSrc: (p) => p,
      Channel: class {
        onmessage = null;
      },
    },
    event: {
      async listen(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return () => {};
      },
      async emit() {},
    },
  };
}

/**
 * 開一個新頁面；回傳頁面、頁面上的錯誤，以及被擋下的外部請求。
 * `desktop` 是假原生端的回應（指令名稱 → 回傳值，或依序回傳的陣列）；不給就是網頁版。
 */
export async function open({ desktop } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-TW" });
  if (desktop) await context.addInitScript(fakeTauri, desktop);
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      return route.abort();
    }
    const file = join(DIST, decodeURIComponent(url.pathname));
    if (!existsSync(file) || url.pathname.endsWith("/")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForSelector(".cm-editor .cm-content");
  return { page, context, errors, external };
}

/** 把編輯器的內容換成 `text`。 */
export async function setText(page, text) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

/** 用指令面板執行一個指令（輸入 `query`，選第一個結果）。 */
export async function runCommand(page, query) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator("dialog[open] input").first();
  await input.waitFor();
  await input.fill(query);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open].palette, dialog[open] .palette"));
}

/** 假原生端被呼叫過的指令。 */
export const calls = (page) => page.evaluate(() => window.__fake.calls);
