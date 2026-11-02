import assert from "node:assert/strict";
import { test } from "node:test";
import { CopyCache, type CopyStore, decodeCopy, encodeCopy, freshnessOf } from "./copy-cache.ts";

function memoryStore(init: Record<string, string> = {}): CopyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("副本格式：新格式帶時間，舊格式（直接存值）也讀得出來", () => {
  assert.deepEqual(decodeCopy(encodeCopy([1, 2], 123)), { value: [1, 2], savedAt: 123 });
  assert.deepEqual(decodeCopy("[1,2]"), { value: [1, 2], savedAt: 0 });
  assert.equal(decodeCopy("{壞掉"), null);
  assert.equal(decodeCopy(null), null);
});

test("沒有副本：向伺服器讀，存下副本，短時間內重讀不再連線", async () => {
  const store = memoryStore();
  let now = 1000;
  const cache = new CopyCache(store, () => now);
  let calls = 0;
  const fetch = async () => (calls++, ["新"]);
  assert.deepEqual(await cache.get("k", fetch), ["新"]);
  await tick();
  assert.deepEqual(decodeCopy(store.data.get("k")!), { value: ["新"], savedAt: 1000 });
  now += 10_000;
  await cache.get("k", fetch);
  assert.equal(calls, 1, "30 秒內沿用");
  now += 30_000;
  await cache.get("k", fetch);
  assert.equal(calls, 2);
  cache.forget();
  await cache.get("k", fetch);
  assert.equal(calls, 3, "忘掉之後一定重讀");
});

test("有副本、要先顯示：馬上回傳副本，背景讀到新的再通知", async () => {
  const store = memoryStore({ k: encodeCopy(["舊"], 500) });
  const cache = new CopyCache(store, () => 1000);
  let release!: (v: string[]) => void;
  const updates: boolean[] = [];
  const first = await cache.get("k", () => new Promise<string[]>((r) => (release = r)), { onUpdate: (c) => updates.push(c) });
  assert.deepEqual(first, ["舊"]);
  assert.deepEqual(freshnessOf(first), { savedAt: 500, state: "updating" });
  release(["新"]);
  await tick();
  assert.deepEqual(updates, [true]);
  // 通知後重新整理畫面：直接拿到新的，不再連線。
  const second = await cache.get("k", () => Promise.reject(new Error("不該再連線")), { onUpdate: () => updates.push(false) });
  assert.deepEqual(second, ["新"]);
  assert.equal(freshnessOf(second), null);
});

test("背景讀取失敗：副本標成「讀不到」，重新整理畫面時不會一直重連", async () => {
  const store = memoryStore({ k: encodeCopy(["舊"], 500) });
  const cache = new CopyCache(store, () => 1000);
  const offline: unknown[] = [];
  let calls = 0;
  const fail = async (): Promise<string[]> => {
    calls++;
    throw new Error("連不上");
  };
  const updates: boolean[] = [];
  const opts = { onUpdate: (c: boolean) => updates.push(c), onOffline: (e: unknown) => offline.push(e) };
  await cache.get("k", fail, opts);
  await tick();
  assert.deepEqual(updates, [false]);
  assert.equal(offline.length, 1);
  const again = await cache.get("k", fail, opts);
  assert.deepEqual(again, ["舊"]);
  assert.deepEqual(freshnessOf(again), { savedAt: 500, state: "failed", error: "連不上" });
  assert.equal(calls, 1);
});

test("沒要先顯示副本：先連線，失敗才用副本", async () => {
  const store = memoryStore({ k: encodeCopy(["舊"], 500) });
  const cache = new CopyCache(store, () => 1000);
  const got = await cache.get("k", async () => {
    throw new Error("連不上");
  });
  assert.deepEqual(got, ["舊"]);
  assert.equal(freshnessOf(got)?.state, "failed");
  await assert.rejects(cache.get("沒有副本", () => Promise.reject(new Error("連不上"))), /連不上/);
});

test("同一個 key 同時讀兩次只連一次", async () => {
  const cache = new CopyCache(memoryStore(), () => 1000);
  let calls = 0;
  const fetch = async () => (calls++, await tick(), ["x"]);
  await Promise.all([cache.get("k", fetch), cache.get("k", fetch)]);
  assert.equal(calls, 1);
});
