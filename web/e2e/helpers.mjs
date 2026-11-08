/**
 * 端對端測試共用的工具：用 Playwright 開啟建置好的 dist/。
 *
 * 不啟動伺服器：攔截瀏覽器的請求，直接回應 dist/ 裡的檔案；其他網址一律擋掉（也確認不會連到外部）。
 * `open({ desktop })` 會在頁面載入前放一個假的 Tauri 介面（`window.__TAURI__`），用來測試桌面版才有的畫面：
 * 原生指令的回應由 `desktop` 決定（也可以用 `{ $by: 參數名稱, values }` 依參數回應、`{ $delay: 毫秒, value }` 慢一點回應、
 * `{ $error: 訊息 }` 回應失敗），呼叫過的指令與參數記在 `window.__fake.calls`，
 * 測試可以用 `window.__fake.emit(事件, 內容)` 模擬原生端送來的事件。
 * 終端機頁面（`open({ desktop, page: "terminal.html" })`）不收聽事件，原生端的資料只從它交給 `term_ready` 的
 * Channel 送來：用 `window.__fake.channel(種類, 內容)` 模擬（送給最近一次當作參數傳給指令的 Channel）。
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
  class Channel {
    onmessage = null;
    // 和 Tauri 一樣，傳給原生端時只送出編號。
    toJSON() {
      return "__CHANNEL__:fake";
    }
  }
  /** 當作參數傳給指令的 Channel（最後一個是最新的）。 */
  const channels = [];
  window.__fake = {
    calls,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn({ payload });
    },
    /** 收聽過的事件名稱。 */
    listened: () => [...listeners.keys()],
    channel(event, payload) {
      const ch = channels.at(-1);
      if (!ch) throw new Error("還沒有 Channel 傳給原生端");
      ch.onmessage?.({ event, payload });
    },
  };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        if (args && typeof args === "object") channels.push(...Object.values(args).filter((v) => v instanceof Channel));
        calls.push({ cmd, args: args ?? null });
        const queue = queues.get(cmd);
        if (!queue) return cmd in DEFAULTS ? DEFAULTS[cmd] : null;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        // `{ $by: "id", values: { 42: … } }`：依參數決定回應（例如依工作項目編號）。
        if (next && typeof next === "object" && "$by" in next) return next.values[String(args?.[next.$by])] ?? null;
        // `{ $delay: 毫秒, value }`：慢一點才回應（模擬伺服器很慢）；`{ $error: 訊息 }`：失敗（模擬連不上）。
        if (next && typeof next === "object" && "$delay" in next) {
          await new Promise((r) => setTimeout(r, next.$delay));
          if ("$error" in next) throw next.$error;
          return next.value ?? null;
        }
        if (next && typeof next === "object" && "$error" in next) throw next.$error;
        return next;
        return cmd in DEFAULTS ? DEFAULTS[cmd] : null;
      },
      // 和 Windows 上的 Tauri 一樣：mdimg 協定的網址是 http://mdimg.localhost/<路徑>（CSP 允許這個來源）。
      convertFileSrc: (p, scheme = "asset") => `http://${scheme}.localhost/${encodeURIComponent(p)}`,
      Channel,
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
 * `page: "terminal.html"` 開終端機的頁面（桌面版的終端機 webview），等 `ready` 選到的元素出現。
 */
export async function open({ desktop, page: path = "index.html", ready = ".cm-editor .cm-content" } = {}) {
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
  await page.goto(`${ORIGIN}/${path}`);
  await page.waitForSelector(ready);
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
