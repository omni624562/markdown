import assert from "node:assert/strict";
import { test } from "node:test";
import { Commands, formatKeys, fuzzyScore, keysFromEvent, keysProblem, matchKeys, normalizeKeys, validKeys, withBinding } from "./commands.ts";

const ev = (code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}, key = "") => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("formatKeys 依平台顯示", () => {
  assert.equal(formatKeys("Mod-Shift-p", true), "⌘⇧P");
  assert.equal(formatKeys("Mod-Shift-p", false), "Ctrl+Shift+P");
  assert.equal(formatKeys("Mod-Alt-1", false), "Ctrl+Alt+1");
});

test("matchKeys 比對實體按鍵與修飾鍵", () => {
  assert.ok(matchKeys("Mod-b", ev("KeyB", { ctrlKey: true }), false));
  assert.ok(matchKeys("Mod-b", ev("KeyB", { metaKey: true }), true));
  assert.ok(!matchKeys("Mod-b", ev("KeyB", { ctrlKey: true, shiftKey: true }), false));
  // macOS 的 Option+1 會產生「¡」，仍應比對成功
  assert.ok(matchKeys("Mod-Alt-1", ev("Digit1", { metaKey: true, altKey: true }, "¡"), true));
  assert.ok(matchKeys("F1", ev("F1", {}, "F1"), false));
});

test("= 與 - 鍵用名稱表示，也接受數字鍵盤", () => {
  assert.equal(formatKeys("Mod-Equal", false), "Ctrl+=");
  assert.equal(formatKeys("Mod-Minus", true), "⌘-");
  assert.ok(matchKeys("Mod-Equal", ev("Equal", { ctrlKey: true }, "="), false));
  assert.ok(matchKeys("Mod-Equal", ev("NumpadAdd", { ctrlKey: true }, "+"), false));
  assert.ok(matchKeys("Mod-Minus", ev("Minus", { ctrlKey: true }, "-"), false));
  assert.ok(!matchKeys("Mod-Minus", ev("Equal", { ctrlKey: true }, "="), false));
});

test("fuzzyScore 支援連續與跳躍比對", () => {
  assert.ok(fuzzyScore("匯出", "匯出 HTML") > fuzzyScore("匯H", "匯出 HTML"));
  assert.ok(fuzzyScore("json", "格式化 JSON") > 0);
  assert.equal(fuzzyScore("xyz", "儲存"), 0);
  assert.equal(fuzzyScore("", "任何"), 1);
});

test("錄製快速鍵：修飾鍵固定順序，字母與數字看實體按鍵", () => {
  assert.equal(keysFromEvent(ev("KeyK", { ctrlKey: true, shiftKey: true }, "K"), false), "Mod-Shift-k");
  assert.equal(keysFromEvent(ev("KeyK", { metaKey: true, ctrlKey: true }, "k"), true), "Mod-Ctrl-k");
  // macOS 的 Option+1 產生「¡」，記成數字 1。
  assert.equal(keysFromEvent(ev("Digit1", { metaKey: true, altKey: true }, "¡"), true), "Mod-Alt-1");
  assert.equal(keysFromEvent(ev("Minus", { ctrlKey: true }, "-"), false), "Mod-Minus");
  assert.equal(keysFromEvent(ev("F6", {}, "F6"), false), "F6");
  assert.equal(keysFromEvent(ev("Comma", { ctrlKey: true }, ","), false), "Mod-,");
  // 只按了修飾鍵、Windows 鍵：繼續等。
  assert.equal(keysFromEvent(ev("ShiftLeft", { shiftKey: true }, "Shift"), false), null);
  assert.equal(keysFromEvent(ev("KeyE", { metaKey: true }, "e"), false), null);
  // 錄下來的快速鍵按下去要比對得到。
  for (const [e, mac] of [
    [ev("KeyK", { ctrlKey: true, altKey: true }, "k"), false],
    [ev("KeyK", { metaKey: true, altKey: true }, "˚"), true],
    [ev("Space", { ctrlKey: true }, " "), false],
    [ev("Slash", { ctrlKey: true, shiftKey: true }, "?"), false],
  ] as const) {
    assert.ok(matchKeys(keysFromEvent(e, mac)!, e, mac), JSON.stringify(e));
  }
});

test("快速鍵的標準寫法：Windows 的 Ctrl 就是 Mod", () => {
  assert.equal(normalizeKeys("Shift-Alt-f", false), "Alt-Shift-f");
  assert.equal(normalizeKeys("Ctrl-Tab", false), "Mod-Tab");
  assert.equal(normalizeKeys("Ctrl-Tab", true), "Ctrl-Tab");
  assert.equal(normalizeKeys("Mod-Shift-P", true), "Mod-Shift-p");
});

test("不能用的快速鍵：沒有修飾鍵、編輯區的基本按鍵", () => {
  assert.equal(keysProblem("k", false), "modifier");
  assert.equal(keysProblem("Shift-k", false), "modifier");
  assert.equal(keysProblem("Ctrl-c", false), "reserved");
  assert.equal(keysProblem("Mod-Shift-z", true), "reserved");
  assert.equal(keysProblem("F6", false), null);
  assert.equal(keysProblem("Shift-F6", false), null);
  assert.equal(keysProblem("Alt-k", false), null);
  assert.equal(keysProblem("Ctrl-k", true), null);
});

test("設定檔裡的快速鍵寫法", () => {
  for (const ok of ["Mod-Shift-p", "F5", "Alt-PageDown", "Mod-Equal", "Ctrl-Alt-[", "Mod-,", "Mod-Space"]) assert.ok(validKeys(ok), ok);
  for (const bad of ["", "Mod-", "Mod-Mod-p", "Hyper-p", "Mod-P", "Mod-<script>", "Mod- "]) assert.ok(!validKeys(bad), bad);
});

test("自訂快速鍵：覆蓋、拿掉、還原內建的", () => {
  const commands = new Commands();
  const cmd = (id: string, keys?: string) => ({ id, title: id, group: "g", keys, run() {} });
  commands.register(cmd("bold", "Mod-b"), cmd("save", "Mod-s"), cmd("plain"));
  commands.setBindings({ bold: "Mod-Shift-b", save: "", plain: "Alt-p" });
  assert.equal(commands.get("bold")!.keys, "Mod-Shift-b");
  assert.equal(commands.get("save")!.keys, undefined);
  assert.equal(commands.get("plain")!.keys, "Alt-p");
  assert.equal(commands.defaultKeys("bold"), "Mod-b");
  assert.equal(commands.match(ev("KeyP", { altKey: true }, "p"))?.id, "plain");
  assert.equal(commands.match(ev("KeyS", { ctrlKey: true }, "s")), undefined);
  // 之後才登記的指令也套用自訂的快速鍵。
  commands.setBindings({ later: "Mod-l" });
  commands.register(cmd("later", "F9"));
  assert.equal(commands.get("later")!.keys, "Mod-l");
  assert.equal(commands.get("bold")!.keys, "Mod-b");
  assert.deepEqual(commands.usedBy("Mod-B").map((c) => c.id), ["bold"]);
  assert.deepEqual(commands.usedBy("Mod-b", "bold"), []);
  // 只顯示的快速鍵（編輯區處理的）：算在衝突裡；自訂之後就不再顯示。
  commands.register({ ...cmd("paste-plain"), shownKeys: "Mod-Shift-v" });
  assert.equal(commands.defaultKeys("paste-plain"), "Mod-Shift-v");
  assert.deepEqual(commands.usedBy("Mod-Shift-v").map((c) => c.id), ["paste-plain"]);
  commands.setBindings({ "paste-plain": "" });
  assert.equal(commands.get("paste-plain")!.shownKeys, undefined);
  commands.setBindings({});
  assert.equal(commands.get("paste-plain")!.shownKeys, "Mod-Shift-v");
});

test("同一個 id 只能登記一次：重複時丟出錯誤，不會出現兩個同名的指令", () => {
  const commands = new Commands();
  const cmd = (id: string) => ({ id, title: id, group: "g", run() {} });
  commands.register(cmd("git-commit"), cmd("git-push"));
  assert.throws(() => commands.register(cmd("git-commit")), /git-commit/);
  assert.throws(() => commands.register(cmd("a"), cmd("a")), /\ba\b/);
  assert.deepEqual(
    commands.all().map((c) => c.id),
    ["git-commit", "git-push", "a"],
  );
});

test("設定裡留著已經拿掉的指令的快速鍵：直接忽略，其他指令照常", () => {
  const commands = new Commands();
  const cmd = (id: string, keys?: string) => ({ id, title: id, group: "g", keys, run() {} });
  commands.setBindings({ "customize-shortcuts": "Mod-Alt-k", "show-search": "", bold: "Mod-Shift-b" });
  commands.register(cmd("bold", "Mod-b"), cmd("show-shortcuts", "F1"));
  assert.equal(commands.get("customize-shortcuts"), undefined);
  assert.equal(commands.get("bold")!.keys, "Mod-Shift-b");
  assert.equal(commands.get("show-shortcuts")!.keys, "F1");
  assert.equal(commands.match(ev("KeyK", { ctrlKey: true, altKey: true }, "k")), undefined);
  assert.deepEqual(commands.usedBy("Mod-Alt-k"), []);
});

test("改快速鍵：跟內建一樣就不記，搶來的指令改成沒有快速鍵", () => {
  const defaults: Record<string, string | undefined> = { bold: "Mod-b", italic: "Mod-i", plain: undefined };
  const def = (id: string) => defaults[id];
  assert.deepEqual(withBinding({}, "bold", "Mod-Shift-b", def, [], false), { bold: "Mod-Shift-b" });
  // 改回內建的（寫法不同也算一樣）。
  assert.deepEqual(withBinding({ bold: "Mod-Shift-b" }, "bold", "Ctrl-b", def, [], false), {});
  assert.deepEqual(withBinding({}, "bold", null, def, [], false), { bold: "" });
  assert.deepEqual(withBinding({ plain: "Alt-p" }, "plain", null, def, [], false), {});
  // 把 Ctrl+I 給 plain：italic 變成沒有快速鍵。
  assert.deepEqual(withBinding({}, "plain", "Mod-i", def, ["italic"], false), { plain: "Mod-i", italic: "" });
});
