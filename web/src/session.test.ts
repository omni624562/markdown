import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
});

const { dropOrphanDrafts, loadProjectView, loadSession, orphanDraftIds, peekSession, saveDraft, saveProjectView, saveSession, sessionKey } =
  await import("./session.ts");

const meta = (id: string) => ({ id, name: `${id}.md`, kind: "markdown" as const, path: `C:\\筆記\\${id}.md`, baseline: null, fileBacked: true });

beforeEach(() => store.clear());

test("每個專案各自保存分頁", () => {
  saveSession({ docs: [meta("a")], activeId: "a" }, "C:\\專案A");
  saveSession({ docs: [meta("b")], activeId: "b" }, "C:\\專案B");
  assert.equal(loadSession("C:\\專案A")?.docs[0].id, "a");
  assert.equal(loadSession("C:\\專案B")?.docs[0].id, "b");
  assert.equal(sessionKey(null), "tabs");
  assert.equal(sessionKey("C:\\專案A"), "tabs@C:\\專案A");
});

test("專案還沒有自己的分頁時，接手舊版共用的分頁（只接手一次）", () => {
  saveSession({ docs: [meta("old")], activeId: "old" });
  // 只是看看（例如檢查有沒有沒存的分頁）不會接手。
  assert.equal(peekSession("C:\\專案A"), null);
  assert.ok(store.has("md-editor:tabs"));
  assert.equal(loadSession("C:\\專案A")?.docs[0].id, "old");
  assert.equal(store.get("md-editor:tabs"), undefined);
  assert.equal(loadSession("C:\\專案B"), null);
});

test("記住檔案樹展開的資料夾，壞掉的資料當作沒有", () => {
  saveProjectView("C:\\專案A", { expanded: ["C:\\專案A\\docs", "C:\\專案A\\img"] });
  assert.deepEqual(loadProjectView("C:\\專案A").expanded, ["C:\\專案A\\docs", "C:\\專案A\\img"]);
  store.set("md-editor:view@C:\\壞", "{not json");
  assert.deepEqual(loadProjectView("C:\\壞").expanded, []);
  assert.deepEqual(loadProjectView("C:\\沒有").expanded, []);
});

test("找出沒有分頁用到的草稿", () => {
  const a = JSON.stringify({ docs: [{ id: "a" }, { id: "b" }], activeId: "a" });
  const c = JSON.stringify({ docs: [{ id: "c" }], activeId: "c" });
  assert.deepEqual(orphanDraftIds([a, c, null], ["a", "b", "c", "x", "y"]), ["x", "y"]);
  assert.deepEqual(orphanDraftIds([], ["x"]), ["x"]);
  // 有分頁清單讀不懂：一律不清。
  assert.deepEqual(orphanDraftIds([a, "{壞掉"], ["x"]), []);
  assert.deepEqual(orphanDraftIds([JSON.stringify({ foo: 1 })], ["x"]), []);
});

test("清掉孤兒草稿，保留各專案分頁的草稿", () => {
  const meta = (id: string) => ({ id, name: `${id}.md`, kind: "markdown" as const, path: null, baseline: null, fileBacked: false });
  saveSession({ docs: [meta("p1")], activeId: "p1" }, "D:/甲");
  saveSession({ docs: [meta("n1")], activeId: "n1" });
  for (const id of ["p1", "n1", "old1", "old2"]) saveDraft(id, id);
  assert.equal(dropOrphanDrafts(), 2);
  assert.equal(store.has("md-editor:draft:p1"), true);
  assert.equal(store.has("md-editor:draft:n1"), true);
  assert.equal(store.has("md-editor:draft:old1"), false);
});
