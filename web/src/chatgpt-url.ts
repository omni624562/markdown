/**
 * 「傳給 ChatGPT」的網址（見 app/chatgpt.ts）。和原生端 `desktop/src/chatgpt.rs` 用同樣的編碼與長度上限：
 * 桌面版 oMarker 交給原生端組網址，這裡只用來事先判斷放不放得下；網頁版 oMarker 直接用這裡組的網址。
 */
import type { ChatgptSend } from "./settings.ts";

/**
 * 網址最長幾個字元（編碼之後），和原生端的 `chatgpt::MAX_URL_LEN` 一樣。Windows 交給系統開啟網址時，
 * 有些地方仍然只接受 2083 個字元，ChatGPT 的伺服器也不一定收很長的網址，所以保守一點。
 */
export const MAX_URL_LENGTH = 2000;

const PREFIX: Record<Exclude<ChatgptSend, "off">, string> = {
  desktop: "codex://new?prompt=",
  web: "https://chatgpt.com/?q=",
};

/** 和原生端一樣的編碼：只留英數字與 `-_.~`，其他字元都用 UTF-8 的 %XX。 */
export function encodePrompt(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 帶著 `text` 的 ChatGPT 網址；太長放不下時回傳 null。沒有文字時網頁版開首頁、桌面版回傳 null。 */
export function chatgptUrl(target: Exclude<ChatgptSend, "off">, text: string): string | null {
  if (!text.trim()) return target === "web" ? "https://chatgpt.com/" : null;
  const url = PREFIX[target] + encodePrompt(text);
  return url.length <= MAX_URL_LENGTH ? url : null;
}
