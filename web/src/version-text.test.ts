import assert from "node:assert/strict";
import { test } from "node:test";
import { engineName, reportIssueUrl, systemName, versionInfoText } from "./version-text.ts";

const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80";

test("Windows 10 與 11 的 User-Agent 一樣，看 platformVersion 分辨", () => {
  assert.equal(systemName(WIN, "15.0.0"), "Windows 11");
  assert.equal(systemName(WIN, "13.0.0"), "Windows 11");
  assert.equal(systemName(WIN, "10.0.0"), "Windows 10");
  assert.equal(systemName(WIN, "0.3.0"), "Windows");
  assert.equal(systemName(WIN), "Windows");
  assert.equal(systemName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"), "Linux");
  assert.equal(systemName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15"), "macOS");
});

test("顯示核心：桌面版是 WebView2，網頁版是瀏覽器", () => {
  assert.equal(engineName(WIN, true), "WebView2 130.0.2849.80");
  assert.equal(engineName(WIN, false), "Edge 130.0.2849.80");
  assert.equal(engineName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Safari/537.36", false), "Chrome 130.0.6723.58");
  assert.equal(engineName("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0", false), "Firefox 132.0");
  assert.equal(engineName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15", false), "Safari 17.1");
});

test("版本資訊三行：版本與管道、建置、系統與核心；自行編譯的沒有管道", () => {
  assert.equal(
    versionInfoText({ version: "1.130.0", channel: "穩定版", build: "第 412 次建置・abc1234", system: "Windows 11", engine: "WebView2 130.0.2849.80" }),
    "oMarker 1.130.0（穩定版）\n第 412 次建置・abc1234\nWindows 11・WebView2 130.0.2849.80",
  );
  assert.equal(versionInfoText({ version: "1.130.0", channel: "網頁版", build: null, system: "macOS", engine: "Safari 17.1" }), "oMarker 1.130.0（網頁版）\nmacOS・Safari 17.1");
  assert.equal(versionInfoText({ version: "0.0.0", channel: null, build: "自行編譯", system: "Linux", engine: "WebKit" }), "oMarker 0.0.0\n自行編譯\nLinux・WebKit");
});

test("回報問題的網址：內文最後是版本資訊，前面用註解提醒不要貼公司的資料", () => {
  const url = reportIssueUrl("oMarker 1.130.0（穩定版）\nWindows 11・WebView2 130.0.2849.80");
  assert.ok(url.startsWith("https://github.com/omni624562/markdown/issues/new?body="), url);
  const body = decodeURIComponent(url.slice(url.indexOf("body=") + 5));
  assert.match(body, /^<!-- .*請不要貼上公司的文件內容.* -->\n/);
  assert.ok(body.endsWith("\n---\noMarker 1.130.0（穩定版）\nWindows 11・WebView2 130.0.2849.80"), body);
  // 網址不能太長（Windows 交給瀏覽器開啟時有長度限制）。
  assert.ok(url.length < 2000, String(url.length));
});
