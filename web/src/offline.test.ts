import assert from "node:assert/strict";
import { test } from "node:test";
import { addImage, keep, parseKept, type KeptPage } from "./offline.ts";

const wiki = { id: "w1", name: "P.wiki", project: "P", projectId: "p1", code: false, repositoryId: "r", mappedPath: "/", version: null, webUrl: null };
const page = (key: string, images: string[] = []): KeptPage => ({ key, title: key, label: "", ref: { type: "wiki", wiki, path: "/a" }, images, savedAt: 1 });

test("parseKept 略過格式不對與重複的項目", () => {
  assert.deepEqual(parseKept(null), []);
  assert.deepEqual(parseKept("壞掉"), []);
  assert.deepEqual(parseKept("{}"), []);
  const list = parseKept(
    JSON.stringify([
      page("a"),
      page("a"),
      { key: "b", ref: { type: "ado", item: { id: 3, title: "x" } } },
      { key: "c", ref: { type: "github" } },
      { key: "d" },
    ]),
  );
  assert.deepEqual(
    list.map((p) => p.key),
    ["a", "b"],
  );
  assert.equal(list[1].title, "b");
  assert.deepEqual(list[1].images, []);
});

test("keep 放在最前面、合併圖片；addImage 只加在清單裡的頁面", () => {
  let list = keep([page("a", ["i1"]), page("b")], page("a", ["i2"]));
  assert.deepEqual(
    list.map((p) => p.key),
    ["a", "b"],
  );
  assert.deepEqual(list[0].images, ["i1", "i2"]);
  list = addImage(list, "b", "i3");
  list = addImage(list, "b", "i3");
  list = addImage(list, "z", "i4");
  assert.deepEqual(list[1].images, ["i3"]);
  assert.equal(list.length, 2);
});
