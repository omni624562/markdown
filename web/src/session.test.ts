import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { loadProjectView, loadSession, peekSession, saveProjectView, saveSession, sessionKey } = await import("./session.ts");

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
