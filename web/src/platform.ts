/**
 * 在哪一種殼裡執行。Android 版（Tauri 的 WebView）有 `window.__TAURI__`，但沒有桌面版的原生指令：
 * 其餘程式碼把它當成網頁版（`desktop` 是 null），只有檔案的開啟與存檔走 Android 的檔案選擇器（見 mobile-files.ts）。
 */
export const isMobileApp: boolean =
  typeof window !== "undefined" &&
  !!(window as { __TAURI__?: unknown }).__TAURI__ &&
  // 原生端啟動時會設這個旗標（android/src/lib.rs）；識別字串是備用的判斷。
  (!!(window as { __OMARKER_ANDROID__?: boolean }).__OMARKER_ANDROID__ || /Android/i.test(navigator.userAgent));
