/** 非阻斷式通知，取代 alert()。可附一個動作按鈕（例如「復原」）。 */

export interface ToastOptions {
  tone?: "info" | "success" | "error";
  action?: { label: string; run(): void };
  /** 顯示時間（毫秒）。有動作按鈕時預設較長。 */
  duration?: number;
}

const region = document.createElement("div");
region.className = "toasts";
region.setAttribute("role", "status");
region.setAttribute("aria-live", "polite");
document.body.append(region);

export function toast(message: string, opts: ToastOptions = {}): void {
  const el = document.createElement("div");
  el.className = `toast toast-${opts.tone ?? "info"}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);

  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // 使用者關閉動畫時不會觸發 animationend。
    setTimeout(() => el.remove(), 300);
  };

  if (opts.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      opts.action!.run();
      close();
    });
    el.append(btn);
  }

  // 錯誤訊息要讓螢幕閱讀器立即唸出。
  if (opts.tone === "error") el.setAttribute("role", "alert");
  region.append(el);
  timer = window.setTimeout(close, opts.duration ?? (opts.action ? 8000 : 3500));
  el.addEventListener("pointerenter", () => clearTimeout(timer));
  el.addEventListener("pointerleave", () => (timer = window.setTimeout(close, 2000)));
}
