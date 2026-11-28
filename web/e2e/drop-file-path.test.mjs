/**
 * 把檔案拖進視窗（app/file-drop.ts）：桌面版（Windows）會問原生端檔案原本的路徑，和「開啟檔案」一樣開起來，
 * 存檔直接存回原處，不會跳另存新檔。拿不到路徑時（其他平台）照舊用檔案內容開成新文件。
 * 用假的原生端（見 helpers.mjs）。先執行 `npm run build`，再 `npm run test:e2e`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { calls, open } from "./helpers.mjs";

const DIR = "C:\\Users\\me\\.config\\tool";
const PATH = `${DIR}\\status.sh`;
const TEXT = "#!/bin/sh\necho ok\n";

/** 把一個檔案拖放到視窗上（放在編輯區）。 */
async function dropFile(page, name, text) {
  const data = await page.evaluateHandle(
    ([name, text]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: "text/plain" }));
      return dt;
    },
    [name, text],
  );
  await page.dispatchEvent(".editor-pane", "dragenter", { dataTransfer: data });
  await page.dispatchEvent(".editor-pane", "drop", { dataTransfer: data });
}

test("拖進來的檔案記得原本的路徑：存檔直接存回原處，不跳另存新檔", async () => {
  const { page, context, errors } = await open({
    desktop: {
      dropped_file: { path: PATH, name: "status.sh", text: TEXT, encoding: "utf-8" },
      save_file: { status: "saved", path: PATH, name: "status.sh" },
    },
  });
  // WebView2 才有的管道：記下前端交給原生端的訊息與檔案。
  await page.evaluate(() => {
    window.__posted = [];
    window.chrome = { ...(window.chrome ?? {}), webview: { postMessageWithAdditionalObjects: (msg, files) => window.__posted.push({ msg, names: [...files].map((f) => f.name) }) } };
  });
  await dropFile(page, "status.sh", TEXT);
  await page.waitForFunction(() => document.querySelector("#tab-bar .tab[aria-selected=true] .tab-name")?.textContent === "status.sh");
  const posted = await page.evaluate(() => window.__posted);
  assert.equal(posted.length, 1);
  assert.match(posted[0].msg, /^omarkerDrop:drop-[a-z0-9-]+$/);
  assert.deepEqual(posted[0].names, ["status.sh"]);
  const asked = (await calls(page)).find((c) => c.cmd === "dropped_file").args;
  assert.deepEqual(asked, { id: posted[0].msg.slice("omarkerDrop:".length), index: 0 });

  // 改一個字再存檔：存回原本的路徑。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("# done");
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__fake.calls.some((c) => c.cmd === "save_file"));
  const saved = (await calls(page)).find((c) => c.cmd === "save_file").args;
  assert.equal(saved.path, PATH, `存回原本的路徑：${JSON.stringify({ ...saved, text: undefined })}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("拿不到路徑（原生端回傳 null、或沒有 WebView2 的管道）：照舊用內容開成新文件", async () => {
  const { page, context, errors } = await open({ desktop: { dropped_file: null } });
  // 沒有 WebView2 的管道：不會去問原生端。
  await dropFile(page, "筆記.md", "# 筆記\n");
  await page.locator(".toast", { hasText: "已開啟「筆記.md」" }).waitFor();
  assert.equal((await calls(page)).filter((c) => c.cmd === "dropped_file").length, 0);
  // 有管道但原生端拿不到路徑。
  await page.evaluate(() => {
    window.chrome = { ...(window.chrome ?? {}), webview: { postMessageWithAdditionalObjects: () => {} } };
  });
  await dropFile(page, "清單.md", "# 清單\n");
  await page.locator(".toast", { hasText: "已開啟「清單.md」" }).waitFor();
  assert.equal((await calls(page)).filter((c) => c.cmd === "dropped_file").length, 1);
  assert.match(await page.locator(".cm-content").textContent(), /清單/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("應該拿得到路徑卻失敗：照舊開成新文件，但提示拿不到原本的位置與原因", async () => {
  const { page, context, errors } = await open({ desktop: { dropped_file: { $error: "沒有收到 WebView2 送來的檔案" } } });
  await page.evaluate(() => {
    window.chrome = { ...(window.chrome ?? {}), webview: { postMessageWithAdditionalObjects: () => {} } };
  });
  await dropFile(page, "清單.md", "# 清單\n");
  await page.locator(".toast", { hasText: "已開啟「清單.md」，但拿不到原本的位置（沒有收到 WebView2 送來的檔案）：存檔時要選位置" }).waitFor();
  assert.match(await page.locator(".cm-content").textContent(), /清單/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("一次拖好幾個檔案：每一個都開起來；有路徑的照路徑開，圖片以外的都算", async () => {
  const OTHER = `${DIR}\\notes.md`;
  const { page, context, errors } = await open({
    desktop: {
      dropped_file: {
        $by: "index",
        values: {
          0: { path: PATH, name: "status.sh", text: TEXT, encoding: "utf-8" },
          1: { path: OTHER, name: "notes.md", text: "# 筆記\n", encoding: "utf-8" },
        },
      },
    },
  });
  await page.evaluate(() => {
    window.__posted = [];
    window.chrome = { ...(window.chrome ?? {}), webview: { postMessageWithAdditionalObjects: (msg, files) => window.__posted.push({ msg, names: [...files].map((f) => f.name) }) } };
  });
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["#!/bin/sh\n"], "status.sh", { type: "text/plain" }));
    dt.items.add(new File(["# 筆記\n"], "notes.md", { type: "text/markdown" }));
    dt.items.add(new File(["沒有路徑的檔案\n"], "臨時.txt", { type: "text/plain" }));
    return dt;
  });
  await page.dispatchEvent(".editor-pane", "dragenter", { dataTransfer: data });
  await page.dispatchEvent(".editor-pane", "drop", { dataTransfer: data });
  await page.locator(".toast", { hasText: "已開啟 3 個檔案" }).waitFor();
  const tabs = await page.locator("#tab-bar .tab .tab-name").allTextContents();
  for (const name of ["status.sh", "notes.md", "臨時.txt"]) assert.ok(tabs.includes(name), `${name}：${tabs.join()}`);
  // 檔案只交給原生端一次；每個檔案各問一次路徑。
  const posted = await page.evaluate(() => window.__posted);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].names, ["status.sh", "notes.md", "臨時.txt"]);
  const asked = (await calls(page)).filter((c) => c.cmd === "dropped_file").map((c) => c.args.index);
  assert.deepEqual(asked, [0, 1, 2]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("拖進來的 PDF：和檔案面板一樣開成檢視分頁（不當成文字讀）", async () => {
  const pdf = "C:\\Users\\me\\Downloads\\規格書.pdf";
  const { page, context, errors } = await open({ desktop: { dropped_view_path: pdf } });
  await page.evaluate(() => {
    window.chrome = { ...(window.chrome ?? {}), webview: { postMessageWithAdditionalObjects: () => {} } };
  });
  await dropFile(page, "規格書.pdf", "%PDF-1.4");
  const frame = page.locator(".pdf-view iframe.pdf-view-frame");
  await frame.waitFor({ state: "attached" });
  assert.match(decodeURIComponent(await frame.getAttribute("src")), /規格書\.pdf$/);
  assert.equal((await calls(page)).filter((c) => c.cmd === "dropped_file").length, 0, "不當成文字檔開");
  assert.deepEqual(errors, []);
  await context.close();
});
