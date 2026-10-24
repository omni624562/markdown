import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDoc as parse } from "./test-wasm.ts";
import { WorkspaceIndex } from "./workspace-index.ts";

const parseDoc = (text: string) => parse(text, 2026);

test("資料夾索引：只收解析結果，需要內容時才讀，而且只讀沒開啟的檔案", async () => {
  const disk: Record<string, string> = { "/w/a.md": "- [ ] 甲 #標籤", "/w/b.md": "[[a]]" };
  const reads: string[][] = [];
  let scans = 0;
  const index = new WorkspaceIndex(
    async (known) => {
      scans++;
      return Object.keys(disk).map((path) => ({
        path,
        rel: path.slice(3),
        mtime: 1,
        info: known[path] === 1 ? null : parseDoc(disk[path]),
      }));
    },
    async (paths) => {
      reads.push(paths);
      return paths.map((p) => disk[p] ?? null);
    },
    parseDoc,
  );
  await index.refresh("/w");
  const open = [{ id: "t1", path: "/w/b.md", name: "b.md", text: "[[a]] 編輯中" }];
  const docs = index.docs(open);
  assert.deepEqual(docs.map((d) => [d.rel, d.text]), [["a.md", null], ["b.md", "[[a]] 編輯中"]]);
  assert.deepEqual(docs[0].info.tags, ["標籤"]);
  assert.deepEqual(await index.texts(docs), ["- [ ] 甲 #標籤", "[[a]] 編輯中"]);
  assert.deepEqual(reads, [["/w/a.md"]]);

  // 沒改過的檔案沿用上次的結果。
  await index.refresh("/w");
  assert.equal(scans, 2);
  assert.deepEqual(index.docs([])[0].info.tags, ["標籤"]);

  index.remember("/w/a.md", "- [x] 甲 #新標籤");
  assert.deepEqual(index.docs([])[0].info.tags, ["新標籤"]);

  delete disk["/w/a.md"];
  await assert.rejects(index.text(index.docs([])[0]), /a\.md/);
});
