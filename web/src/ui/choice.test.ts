import assert from "node:assert/strict";
import { test } from "node:test";
import { type ChoiceOption, choiceLayout } from "./choice.ts";

const ids = (options: ChoiceOption[]) => options.map((o) => o.id);

test("確認對話框：危險的動作在左、取消在最右邊，預設聚焦取消（不管呼叫端怎麼排）", () => {
  const cancelFirst = choiceLayout([
    { id: "cancel", label: "取消" },
    { id: "delete", label: "刪除", danger: true },
  ]);
  const dangerFirst = choiceLayout([
    { id: "delete", label: "刪除", danger: true },
    { id: "cancel", label: "取消", primary: true },
  ]);
  for (const layout of [cancelFirst, dangerFirst]) {
    assert.deepEqual(ids(layout.order), ["delete", "cancel"]);
    assert.equal(layout.focus, "cancel");
    // 取消一律是一般樣式，危險的動作不會是主要選項。
    assert.deepEqual(
      layout.order.map((o) => !!o.primary),
      [false, false],
    );
  }
});

test("危險的動作不會預設聚焦，呼叫端指定也一樣", () => {
  const layout = choiceLayout(
    [
      { id: "delete", label: "刪除", danger: true },
      { id: "cancel", label: "取消" },
    ],
    "delete",
  );
  assert.equal(layout.focus, "cancel");
});

test("三個以上的選項：取消在最右邊、危險的動作緊貼在它左邊，預設聚焦不危險的主要選項", () => {
  // 「要儲存變更嗎？」：預設是「儲存」，不會是「不儲存」。
  const unsaved = choiceLayout([
    { id: "save", label: "儲存", primary: true },
    { id: "discard", label: "不儲存", danger: true },
    { id: "cancel", label: "取消" },
  ]);
  // 和 Windows 的「要儲存嗎？」一樣：［儲存］［不儲存］［取消］。
  assert.deepEqual(ids(unsaved.order), ["save", "discard", "cancel"]);
  assert.equal(unsaved.focus, "save");

  const conflict = choiceLayout([
    { id: "compare", label: "比較差異", primary: true },
    { id: "overwrite", label: "用我的版本覆蓋", danger: true },
    { id: "save-as", label: "另存新檔" },
    { id: "cancel", label: "取消" },
  ]);
  assert.deepEqual(ids(conflict.order), ["compare", "save-as", "overwrite", "cancel"]);
  assert.equal(conflict.focus, "compare");
});

test("沒有危險動作的對話框照原本的順序，聚焦指定的或主要選項", () => {
  const options: ChoiceOption[] = [
    { id: "update", label: "更新連結", primary: true },
    { id: "skip", label: "不用" },
  ];
  assert.deepEqual(choiceLayout(options), { order: options, focus: "update" });
  assert.equal(choiceLayout(options, "skip").focus, "skip");
  assert.equal(choiceLayout([{ id: "a", label: "A" }]).focus, null);
});
