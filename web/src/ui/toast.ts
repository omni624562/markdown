/** 非阻斷式通知，取代 alert()。可附一個動作按鈕（例如「復原」）。 */

export interface ToastAction {
  label: string;
  run(): void;
  /** 醒目的按鈕（這則通知主要就是要使用者按它）。 */
  primary?: boolean;
}

export interface ToastOptions {
  tone?: "info" | "success" | "error";
  action?: ToastAction;
  /** 顯示時間（毫秒）。有動作按鈕時預設較長。 */
  duration?: number;
}

const region = document.createElement("div");
region.className = "toasts";
region.setAttribute("role", "status");
region.setAttribute("aria-live", "polite");
// 用 Popover 放進最上層，開著設定等對話框時通知也不會被遮住或變暗。
region.popover = "manual";
document.body.append(region);

/**
 * 把通知區移到最上層（之後才開的對話框會蓋在它上面，所以每次顯示通知時重新放一次）。
 * 開著對話框（例如設定）時，對話框以外的東西都不能點，所以通知區暫時放進對話框裡，關閉時再移回來。
 */
function raise(): void {
  const modal = [...document.querySelectorAll("dialog")].filter((d) => d.matches(":modal")).at(-1);
  const host = modal ?? document.body;
  if (typeof region.showPopover === "function" && region.matches(":popover-open")) region.hidePopover();
  if (region.parentElement !== host) {
    host.append(region);
    modal?.addEventListener("close", () => raise(), { once: true });
  }
  if (typeof region.showPopover === "function" && region.isConnected) region.showPopover();
}

// 通知顯示中才開啟的對話框（例如先跳出「已下載新版」，再打開設定）：
// 通知要跟著移到對話框裡，不然會被對話框的灰色遮罩蓋住、也點不到按鈕。
new MutationObserver((records) => {
  if (!region.childElementCount) return;
  const opened = records.some((r) => r.target instanceof HTMLDialogElement && r.target.open);
  if (opened) raise();
}).observe(document.body, { subtree: true, attributeFilter: ["open"] });

let errorAction: ((message: string) => ToastAction | undefined) | null = null;

/**
 * 錯誤通知自動附上的按鈕（例如「GitHub 登入已過期」附上「重新登入」）。
 * 錯誤訊息來自很多地方（拉取、推送、Issues、Gist…），在這裡統一處理，不用每個地方各自加。
 */
export function setErrorAction(fn: (message: string) => ToastAction | undefined): void {
  errorAction = fn;
}

/** 顯示通知；回傳的 `dismiss()` 可以提早關掉（例如「正在下載…」完成時）。 */
export function toast(message: string, opts: ToastOptions = {}): { dismiss(): void } {
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

  if (!opts.action && opts.tone === "error") {
    const action = errorAction?.(message);
    if (action) opts = { ...opts, action, duration: Math.max(opts.duration ?? 0, 12000) };
  }
  if (opts.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opts.action.label;
    if (opts.action.primary) btn.className = "primary";
    btn.addEventListener("click", () => {
      opts.action!.run();
      close();
    });
    el.append(btn);
  }

  // 錯誤訊息要讓螢幕閱讀器立即唸出。
  if (opts.tone === "error") el.setAttribute("role", "alert");
  // 同一則通知還在畫面上時（例如連按兩次同一個按鈕），換成新的，不要疊兩則一樣的。
  el.dataset.message = message;
  for (const old of region.children) {
    if (old instanceof HTMLElement && old.dataset.message === message && old.className === el.className) old.remove();
  }
  region.append(el);
  raise();
  timer = window.setTimeout(close, opts.duration ?? (opts.action ? 8000 : 3500));
  el.addEventListener("pointerenter", () => clearTimeout(timer));
  el.addEventListener("pointerleave", () => (timer = window.setTimeout(close, 2000)));
  return { dismiss: close };
}
