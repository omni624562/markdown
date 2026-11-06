import assert from "node:assert/strict";
import { test } from "node:test";
import { appChanges, combine, compare, next, notesOf, parseFragment, summary } from "./version.mjs";

test("下一個版本號", () => {
  assert.equal(next("1.4.2", "patch"), "1.4.3");
  assert.equal(next("1.4.2", "minor"), "1.5.0");
  assert.equal(next("1.4.2", "major"), "2.0.0");
  assert.equal(next("1.4.2", "1.6.0"), "1.6.0");
  assert.throws(() => next("1.4.2", "bigger"));
});

test("比較版本號（數字比大小，不是字串）", () => {
  assert.ok(compare("1.10.0", "1.9.9") > 0);
  assert.ok(compare("2.0.0", "10.0.0") < 0);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
});

test("取出某一版的說明與摘要", () => {
  const log = "# 更新紀錄\n\n## 1.1.0 — 2026-10-23\n\n### 新功能\n\n- 斜線指令\n- `@今天` 日期\n\n## 1.0.0 — 2026-10-22\n\n- 第一版\n";
  assert.equal(notesOf(log, "1.1.0"), "### 新功能\n\n- 斜線指令\n- `@今天` 日期");
  assert.equal(notesOf(log, "1.0.0"), "- 第一版");
  assert.equal(notesOf(log, "1.0"), null);
  assert.equal(notesOf(log, "2.0.0"), null);
  assert.equal(summary(notesOf(log, "1.1.0")), "斜線指令；@今天 日期");
  assert.equal(summary("- " + "很長".repeat(100), 10).length, 10);
  // 巢狀清單：冒號後面直接接子項目，句號結尾不重複加分號。
  assert.equal(summary("- 圖示列：\n  - 拖曳頁面。\n  - 右鍵移除。\n- 其他"), "圖示列：拖曳頁面；右鍵移除；其他");
});

test("讀改動片段", () => {
  assert.deepEqual(parseFragment("bump: minor\n\n- 工作板\n"), { bump: "minor", section: "新功能", body: "- 工作板" });
  assert.deepEqual(parseFragment("bump: patch\nsection: 調整\n\n- 配色\n  - 子項目\n"), {
    bump: "patch",
    section: "調整",
    body: "- 配色\n  - 子項目",
  });
  assert.equal(parseFragment("bump: patch\r\n\r\n- Windows 換行\r\n").body, "- Windows 換行");
  assert.throws(() => parseFragment("- 沒有 bump\n"), /bump/);
  assert.throws(() => parseFragment("bump: huge\n\n- x\n"), /patch、minor 或 major/);
  assert.throws(() => parseFragment("bump: patch\nsection: 其他\n\n- x\n"), /section/);
  assert.throws(() => parseFragment("bump: patch\n\n說明沒有項目符號\n"), /- /);
  assert.throws(() => parseFragment("bump: patch\n\n- \n"), /空白/);
});

test("合併片段：升版取最大的，項目依分類排", () => {
  const out = combine([
    parseFragment("bump: patch\n\n- 修好 A"),
    parseFragment("bump: minor\n\n- 新功能 B"),
    parseFragment("bump: patch\nsection: 調整\n\n- 調整 C"),
    parseFragment("bump: patch\n\n- 修好 D"),
  ]);
  assert.equal(out.bump, "minor");
  assert.equal(out.notes, "### 新功能\n\n- 新功能 B\n\n### 調整\n\n- 調整 C\n\n### 修正\n\n- 修好 A\n- 修好 D");
  assert.equal(combine([parseFragment("bump: major\n\n- 拿掉 X"), parseFragment("bump: minor\n\n- Y")]).bump, "major");
});

test("哪些改動要有改動片段：Dependabot 只更新相依套件時不用", () => {
  const npm = ["web/package.json", "web/package-lock.json"];
  const cargo = ["desktop/Cargo.toml", "desktop/Cargo.lock"];
  const crates = ["Cargo.lock", "crates/md-core/Cargo.toml"];
  // 一般的分支：改到 package.json、Cargo.toml 就是改了程式。
  assert.deepEqual(appChanges(npm, "claude/upgrade"), ["web/package.json"]);
  assert.deepEqual(appChanges(cargo), ["desktop/Cargo.toml"]);
  // Dependabot 只動相依套件的清單與鎖定檔：不用片段。
  assert.deepEqual(appChanges(npm, "dependabot/npm_and_yarn/web/vite-7.1.0"), []);
  assert.deepEqual(appChanges(cargo, "dependabot/cargo/desktop/tauri-2.9.0"), []);
  assert.deepEqual(appChanges(crates, "dependabot/cargo/serde-1.0.230"), []);
  // Dependabot 的分支也改了程式本身：照樣要片段。
  assert.deepEqual(appChanges([...npm, "web/src/main.ts"], "dependabot/npm_and_yarn/x"), ["web/package.json", "web/src/main.ts"]);
  // 只改說明、CI 設定：本來就不用。
  assert.deepEqual(appChanges([".github/dependabot.yml", "README.md"]), []);
});
