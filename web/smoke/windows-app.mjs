/**
 * 在 Windows 上真的啟動桌面版，檢查只有 WebView2 才走得到、一般測試（假的原生端）驗不到的路徑。
 * CI 的 windows 工作編譯完執行檔之後跑：`node smoke/windows-app.mjs <執行檔的路徑>`（在 web/ 底下）。
 *
 * 做法：另外編一份開了 `smoke-test` 功能的執行檔（除錯版，只多編主程式那一個套件），用環境變數請它打開 WebView2
 * 遠端偵錯的連接埠，Playwright 連上去（不另外下載瀏覽器）。發佈的執行檔沒有這個功能：Tauri 自己設定瀏覽器的參數，
 * WebView2 的環境變數不會生效，沒辦法從外面打開偵錯。檢查：
 * 1. 程式啟動、主畫面載入、命令列帶入的檔案開起來了；
 * 2. 「拖進來的檔案記得原本的路徑」這條管道：網頁把檔案物件交給原生端（`postMessageWithAdditionalObjects`），
 *    原生端問得出路徑、`dropped_file` 照那個路徑開啟。1.150.0～1.150.2 這裡是壞的（Tauri 自己的處理常式
 *    排在前面、讀不懂物件格式的訊息就擋掉後面的），只能靠使用者在 Windows 上試才發現。
 *
 * 沒辦法模擬真的滑鼠拖放，所以檔案物件是從 `<input type="file">` 來的；交給原生端之後走的路一樣。
 */
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const exe = process.argv[2];
if (!exe) {
  console.error("用法：node smoke/windows-app.mjs <執行檔>");
  process.exit(2);
}
const PORT = 9333;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "omarker-smoke-")));
const opened = join(dir, "啟動.md");
const dropped = join(dir, "拖進來.md");
writeFileSync(opened, "# 啟動時開的檔案\n");
writeFileSync(dropped, "# 拖進來的檔案\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

const child = spawn(exe, [opened], {
  // 這一份執行檔是用 `--features smoke-test` 編的，才認這個環境變數（發佈的執行檔沒有）。
  env: { ...process.env, OMARKER_SMOKE_PORT: String(PORT) },
  stdio: "inherit",
});
let exited = null;
child.on("exit", (code) => (exited = code));

async function connect() {
  for (let i = 0; i < 90; i++) {
    if (exited !== null) throw new Error(`程式啟動後就結束了（結束碼 ${exited}）`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`等了 90 秒還連不上 WebView2 的遠端偵錯連接埠\n${diagnose()}`);
}

/** 連不上時的狀況：連接埠有沒有人在聽、WebView2 的處理程序與它們的命令列（看參數有沒有帶到）。 */
function diagnose() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim() || "（沒有輸出）";
    } catch (e) {
      return `（失敗：${e.message.split("\n")[0]}）`;
    }
  };
  const ps = (script) => run(`powershell -NoProfile -Command "${script}"`);
  // 主要的瀏覽器處理程序（沒有 --type= 的那一個）完整的命令列：看偵錯連接埠的參數有沒有帶到。
  const browser = ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine } | Out-String");
  return [
    `程式還在執行：${exited === null}`,
    `命令列有 --remote-debugging-port：${browser.includes("--remote-debugging-port")}`,
    `瀏覽器處理程序的命令列：${browser}`,
    `在聽的連接埠：${ps("Get-NetTCPConnection -State Listen | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -match 'msedgewebview2|md-editor' } | Format-Table -AutoSize LocalAddress,LocalPort,OwningProcess | Out-String")}`,
    `視窗：${ps("Get-Process md-editor -ErrorAction SilentlyContinue | Format-Table -AutoSize Id,MainWindowTitle,Responding | Out-String")}`,
  ].join("\n");
}

/** 主畫面那一頁（另一頁是終端機）。 */
async function mainPage(browser) {
  for (let i = 0; i < 60; i++) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (/terminal\.html/.test(page.url())) continue;
        if (await page.evaluate(() => !!window.__TAURI__ && !!document.querySelector(".cm-content")).catch(() => false)) return page;
      }
    }
    await sleep(1000);
  }
  const urls = browser.contexts().flatMap((c) => c.pages().map((p) => p.url()));
  throw new Error(`找不到載入完成的主畫面；目前的頁面：${JSON.stringify(urls)}`);
}

let failed = false;
let browser;
try {
  browser = await connect();
  const page = await mainPage(browser);
  console.log(`主畫面：${page.url()}`);

  // 1. 命令列帶入的檔案開起來了。
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("啟動時開的檔案"), null, { timeout: 30_000 });
  console.log("ok  啟動並開啟命令列帶入的檔案");

  // 2. 檔案物件交給原生端 → 問得出路徑 → 照路徑開啟。
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "smoke-file";
    input.style.cssText = "position:fixed;left:0;top:0;opacity:0.01";
    document.body.append(input);
  });
  // 直接用 CDP 指定磁碟上的檔案。Playwright 的 setInputFiles 對 connectOverCDP 連上的瀏覽器會把檔案內容
  // 傳過去再造一個檔案物件，那種物件沒有路徑（WebView2 會說「不是磁碟上的檔案」）。
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#smoke-file" });
  await cdp.send("DOM.setFileInputFiles", { files: [dropped], nodeId });
  const result = await page.evaluate(async () => {
    const file = document.querySelector("#smoke-file").files[0];
    const host = window.chrome?.webview;
    if (!host?.postMessageWithAdditionalObjects) return { error: "沒有 chrome.webview.postMessageWithAdditionalObjects" };
    const id = `drop-smoke-${Date.now().toString(36)}`;
    host.postMessageWithAdditionalObjects(`omarkerDrop:${id}`, [file]);
    try {
      return { file: await window.__TAURI__.core.invoke("dropped_file", { id, index: 0 }) };
    } catch (e) {
      return { error: String(e) };
    }
  });
  if (result.error || !result.file) throw new Error(`拿不到拖進來的檔案的路徑：${result.error ?? "原生端回傳 null"}`);
  if (!same(result.file.path, dropped)) throw new Error(`路徑不對：${result.file.path}（應該是 ${dropped}）`);
  if (!result.file.text.includes("拖進來的檔案")) throw new Error(`內容不對：${JSON.stringify(result.file.text)}`);
  console.log(`ok  拖進來的檔案問得出原本的路徑：${result.file.path}`);
} catch (e) {
  failed = true;
  console.error(`失敗：${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
process.exit(failed ? 1 : 0);
