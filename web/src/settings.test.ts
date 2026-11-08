import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, sanitize } from "./settings.ts";

test("缺少的欄位使用預設值", () => {
  const { settings, problems } = sanitize({ math: false });
  assert.equal(settings.math, false);
  assert.equal(settings.editorFontSize, DEFAULTS.editorFontSize);
  assert.equal(problems, 0);
});

test("型別錯誤或超出範圍的欄位會被修正並計入問題", () => {
  const { settings, problems } = sanitize({ editorFontSize: 99, lineNumbers: "yes", previewWidth: "huge" });
  assert.equal(settings.editorFontSize, 24);
  assert.equal(settings.lineNumbers, DEFAULTS.lineNumbers);
  assert.equal(settings.previewWidth, DEFAULTS.previewWidth);
  assert.equal(problems, 2);
});

test("不是物件時整份退回預設值", () => {
  assert.deepEqual(sanitize(null).settings, DEFAULTS);
  assert.equal(sanitize("壞掉").problems, 1);
});

test("AI 功能預設全部關閉", () => {
  assert.equal(DEFAULTS.aiEnabled, false);
  assert.ok(DEFAULTS.quickActions.length > 0);
});

test("AI 快速動作會去掉無效項目並限制長度", () => {
  const { settings, problems } = sanitize({
    aiTool: "codex",
    quickActions: [
      { name: " 精簡 ", prompt: "改短一點" },
      { name: "", prompt: "沒有名稱" },
      { name: "沒有提示詞" },
      "不是物件",
      { name: "長".repeat(100), prompt: "x" },
    ],
  });
  assert.equal(settings.aiTool, "codex");
  assert.deepEqual(settings.quickActions[0], { name: "精簡", prompt: "改短一點" });
  assert.equal(settings.quickActions.length, 2);
  assert.equal(settings.quickActions[1].name.length, 40);
  assert.equal(problems, 1);
});

test("不認得的 AI 工具退回預設值", () => {
  const { settings, problems } = sanitize({ aiTool: "gpt" });
  assert.equal(settings.aiTool, "claude");
  assert.equal(problems, 1);
});

test("自訂字型名稱會去掉危險字元，型別錯誤時退回預設值", () => {
  const { settings, problems } = sanitize({ docFont: "custom", docFontCustom: ' "霞鶩文楷"; ', codeFont: 3 });
  assert.equal(settings.docFont, "custom");
  assert.equal(settings.docFontCustom, "霞鶩文楷");
  assert.equal(settings.codeFont, DEFAULTS.codeFont);
  assert.equal(problems, 1);
});

test("左側圖示列：只接受合法的 id，去掉重複", () => {
  const { settings, problems } = sanitize({
    activityOrder: ["git", "files", "git", "<script>"],
    activityHidden: ["tags"],
    activityCommands: ["git-history", 3, "toggle-terminal"],
  });
  assert.deepEqual(settings.activityOrder, ["git", "files"]);
  assert.deepEqual(settings.activityHidden, ["tags"]);
  assert.deepEqual(settings.activityCommands, ["git-history", "toggle-terminal"]);
  assert.equal(problems, 2);
  // 預設不釘指令（Git 歷史在原始碼控制面板的標題列）；存過的設定照舊。
  assert.deepEqual(sanitize({}).settings.activityCommands, []);
  assert.deepEqual(sanitize({ activityCommands: ["git-history"] }).settings.activityCommands, ["git-history"]);
  assert.deepEqual(sanitize({ activityCommands: "x" }).settings.activityCommands, DEFAULTS.activityCommands);
});

test("檔案面板上方釘的按鈕：預設沒有，只接受合法的 id", () => {
  assert.deepEqual(sanitize({}).settings.filesHeadCommands, []);
  const { settings, problems } = sanitize({ filesHeadCommands: ["open-in-codex", 3, "open-in-codex", "open-in-claude"] });
  assert.deepEqual(settings.filesHeadCommands, ["open-in-codex", "open-in-claude"]);
  assert.equal(problems, 1);
  assert.deepEqual(sanitize({ filesHeadCommands: "x" }).settings.filesHeadCommands, []);
});

test("左側圖示列預設精簡：待辦總覽、標籤收起來；存過「全部顯示」的照舊", () => {
  assert.deepEqual(DEFAULTS.activityHidden, ["tasks", "tags"]);
  assert.deepEqual(sanitize({}).settings.activityHidden, ["tasks", "tags"]);
  assert.deepEqual(sanitize({ activityHidden: [] }).settings.activityHidden, []);
});

test("工作項目類型的顏色：只留格式正確的", () => {
  assert.deepEqual(sanitize({}).settings.workItemColors, {});
  const { settings, problems } = sanitize({ workItemColors: { Bug: "#00AA00", Task: "yellow" } });
  assert.deepEqual(settings.workItemColors, { Bug: "#00aa00" });
  assert.equal(problems, 1);
  assert.equal(sanitize({ workItemColors: "red" }).problems, 1);
  // 預設值不會被改到（每次都是新的物件）。
  sanitize({}).settings.workItemColors.Bug = "#000000";
  assert.deepEqual(DEFAULTS.workItemColors, {});
});

test("自訂快速鍵：只留合法的 id 與寫法，空字串是拿掉快速鍵", () => {
  const { settings, problems } = sanitize({
    keybindings: { bold: "Mod-Shift-b", save: "", "<x>": "Mod-k", italic: "Hyper-i", link: 3 },
  });
  assert.deepEqual(settings.keybindings, { bold: "Mod-Shift-b", save: "" });
  assert.equal(problems, 1);
  assert.deepEqual(sanitize({}).settings.keybindings, {});
  assert.deepEqual(sanitize({ keybindings: ["Mod-k"] }).settings.keybindings, {});
});

test("英文拼字檢查：預設開啟；個人字典只收小寫英文字", () => {
  assert.equal(DEFAULTS.spellCheck, true);
  const { settings, problems } = sanitize({ spellIgnore: ["kubernetes", "Kubernetes", "bad word", "o'neil", 3, "kubernetes"] });
  assert.deepEqual(settings.spellIgnore, ["kubernetes", "o'neil"]);
  assert.equal(problems, 1);
});

test("每日筆記的資料夾與範本", () => {
  assert.equal(sanitize({}).settings.dailyFolder, "每日筆記");
  assert.equal(sanitize({}).settings.dailyTemplate, "");
  assert.equal(sanitize({ dailyFolder: " 筆記\\每日/ " }).settings.dailyFolder, "筆記/每日");
  assert.equal(sanitize({ dailyFolder: "" }).settings.dailyFolder, "", "空白是放在最上層");
  // 跳出開啟的資料夾、不能用的字元：用預設值，並記一個問題。
  const bad = sanitize({ dailyFolder: "../外面" });
  assert.equal(bad.settings.dailyFolder, "每日筆記");
  assert.equal(bad.problems, 1);
  assert.equal(sanitize({ dailyTemplate: " 我的日誌 " }).settings.dailyTemplate, "我的日誌");
  assert.equal(sanitize({ dailyTemplate: 3 }).problems, 1);
});

test("1.118 的頂端列樣式已經拿掉：設定檔裡留著的 topbarStyle 直接忽略，不算錯誤", () => {
  const { settings, problems } = sanitize({ topbarStyle: "layout" });
  assert.equal(problems, 0);
  assert.ok(!("topbarStyle" in settings));
});

test("分頁樣式：預設是原本的頂端線；只接受三種樣式", () => {
  assert.equal(DEFAULTS.tabStyle, "line");
  assert.equal(sanitize({ tabStyle: "card" }).settings.tabStyle, "card");
  assert.equal(sanitize({ tabStyle: "underline" }).settings.tabStyle, "underline");
  const bad = sanitize({ tabStyle: "round" });
  assert.equal(bad.settings.tabStyle, "line");
  assert.equal(bad.problems, 1);
});

test("區塊樣式：預設是圓角區塊、留間隔；只接受圓角區塊與相連兩種", () => {
  assert.equal(DEFAULTS.panelStyle, "spaced");
  assert.equal(sanitize({ panelStyle: "joined" }).settings.panelStyle, "joined");
  const bad = sanitize({ panelStyle: "floating" });
  assert.equal(bad.settings.panelStyle, "spaced");
  assert.equal(bad.problems, 1);
});

test("傳給 ChatGPT：預設關閉，只接受三種值", () => {
  assert.equal(sanitize({}).settings.chatgptSend, "off");
  assert.equal(sanitize({}).settings.chatgptAcknowledged, false);
  assert.equal(sanitize({ chatgptSend: "desktop" }).settings.chatgptSend, "desktop");
  assert.equal(sanitize({ chatgptSend: "web", chatgptAcknowledged: true }).settings.chatgptAcknowledged, true);
  const bad = sanitize({ chatgptSend: "https://example.test/" });
  assert.equal(bad.settings.chatgptSend, "off");
  assert.equal(bad.problems, 1);
});

test("助理的自訂動作：名稱、提示詞不能空白，回答怎麼用只能是三種之一", () => {
  const { settings, problems } = sanitize({
    assistantActions: [
      { name: " 會議紀錄 ", prompt: "整理成會議紀錄", mode: "insert" },
      { name: "空的", prompt: "  ", mode: "answer" },
      { name: "亂填", prompt: "做點事", mode: "delete" },
      "不是物件",
    ],
  });
  assert.deepEqual(settings.assistantActions, [{ name: "會議紀錄", prompt: "整理成會議紀錄", mode: "insert" }]);
  assert.ok(problems > 0);
  assert.deepEqual(sanitize({}).settings.assistantActions, []);
});
