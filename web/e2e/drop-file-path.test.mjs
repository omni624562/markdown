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
  assert.match(posted[0].msg.omarkerDrop, /^drop-[a-z0-9-]+$/);
  assert.deepEqual(posted[0].names, ["status.sh"]);
  const asked = (await calls(page)).find((c) => c.cmd === "dropped_file").args;
  assert.deepEqual(asked, { id: posted[0].msg.omarkerDrop, index: 0 });

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
