/**
 * 傳給 ChatGPT：把選取的文字、整份 Wiki 頁面或工作項目、Wiki 某一版的內容等帶進 ChatGPT 的輸入框，
 * 由使用者自己按送出。
 *
 * 設定（AI 協作 → 傳給 ChatGPT）預設關閉；打開後，在原本的「複製…」旁邊多一項「傳給 ChatGPT」：
 * 編輯器與預覽選取文字的右鍵選單、Wiki 頁面與工作項目分頁的右鍵選單（「複製成 Markdown 文件」下面）、
 * Wiki 修改紀錄的「複製這一版的內容」、Wiki 衝突的「複製我的完整版本」。路徑、提交編號、連結這類不加。
 * - 桌面版：`codex://new?prompt=…`（ChatGPT 桌面版沿用 Codex 的網址；官方沒有保證，不能用時改用網頁版）。
 * - 網頁版：`https://chatgpt.com/?q=…`。
 * 桌面版 oMarker 的網址由原生端組（`desktop/src/chatgpt.rs`，只接受這兩種），網頁版 oMarker 直接開網頁。
 * 內容太長、網址放不下時，先複製到剪貼簿再開 ChatGPT，讓使用者按 Ctrl+V 貼上。
 * 第一次使用先提醒內容會送到 OpenAI，按「傳給 ChatGPT」後記住，之後不再問。
 */
import { chatgptUrl } from "../chatgpt-url.ts";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import type { ChatgptSend } from "../settings.ts";
import { choose } from "../ui/choice.ts";
import { setSelectionExtras } from "../ui/input-menu.ts";
import { toast } from "../ui/toast.ts";
import { aiAppPresent } from "./ai-app-presence.ts";
import { openUrl } from "./activity-bar.ts";
import { reportError } from "./git-actions.ts";
import { app } from "./context.ts";

/** 設定打開了（選了桌面版或網頁版）。 */
export function chatgptEnabled(): boolean {
  return app.settings.value.chatgptSend !== "off";
}

/** 這次要開哪一個：網頁版的 oMarker 只能開網頁版。 */
function target(): Exclude<ChatgptSend, "off"> | null {
  const v = app.settings.value.chatgptSend;
  if (v === "off") return null;
  return desktop ? v : "web";
}

/** 第一次使用：提醒內容會送到 OpenAI。 */
async function acknowledged(): Promise<boolean> {
  if (app.settings.value.chatgptAcknowledged) return true;
  const pick = await choose(
    t("傳給 ChatGPT"),
    t("內容會送到 OpenAI 的 ChatGPT（公司以外的服務）。公司文件、Wiki、工作項目等資料，請先確認公司規定允許再傳送。之後不會再問，可以在設定關掉這個功能。"),
    [
      { id: "cancel", label: t("取消") },
      { id: "send", label: t("傳給 ChatGPT"), primary: true },
    ],
  );
  if (pick !== "send") return false;
  app.settings.update({ chatgptAcknowledged: true });
  return true;
}

/** 把 `text` 帶進 ChatGPT；太長時先複製到剪貼簿。 */
export async function sendToChatGpt(text: string): Promise<void> {
  const to = target();
  if (!to || !text.trim()) return;
  if (!(await acknowledged())) return;
  let prompt = text;
  if (!chatgptUrl(to, text)) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast(t("無法複製到剪貼簿"), { tone: "error" });
      return;
    }
    // 桌面版的網址一定要帶文字：只帶一句開頭，貼上的內容接在後面。
    prompt = to === "desktop" ? t("以下是內容：") : "";
    toast(t("內容較長，已複製。請在 ChatGPT 按 Ctrl+V 貼上。"), { duration: 8000 });
  }
  if (desktop) await desktop.chatgptSend(to, prompt);
  else openUrl(chatgptUrl("web", prompt) ?? "https://chatgpt.com/");
}

const send = (text: string) => void sendToChatGpt(text).catch(reportError);

/** Wiki 頁面、工作項目分頁的「傳給 ChatGPT」（見 ui/issue-view.ts）。 */
export const chatgptIssueHooks = { enabled: chatgptEnabled, send };

/** 「複製…」按鈕旁邊的「傳給 ChatGPT」按鈕（設定關閉時是 null）。 */
export function chatgptButton(text: () => string, make: (label: string, run: () => void) => HTMLElement): HTMLElement | null {
  return chatgptEnabled() ? make(t("傳給 ChatGPT"), () => send(text())) : null;
}

/** 有沒有 ChatGPT 桌面版（設定裡的桌面版選項用）。 */
export const chatgptDesktopFound = (): boolean => aiAppPresent("codex");

export function initChatGpt(): void {
  app.commands.register({
    id: "send-to-chatgpt",
    title: t("傳給 ChatGPT"),
    group: t("AI 與終端機"),
    icon: "message-square",
    when: () => chatgptEnabled() && app.view !== "preview" && !app.editor.view.state.selection.main.empty,
    run: () => {
      const { from, to } = app.editor.view.state.selection.main;
      send(app.editor.view.state.sliceDoc(from, to));
    },
  });
  // 預覽、工作項目等地方選取的文字（桌面版自己的右鍵選單）。
  setSelectionExtras((text) =>
    chatgptEnabled() && text.trim() ? [{ label: t("傳給 ChatGPT"), icon: "message-square", checked: () => false, run: () => send(text) }] : [],
  );
}
