/**
 * AI 要求在終端機執行指令時的同意提示（終端機 webview，`terminal.html`）。
 *
 * 只在終端機的 webview 顯示：這裡不顯示任何文件內容，主畫面萬一被注入程式碼，也不能替使用者按下同意
 * （原生端的 `mcp_respond` 對指令只接受這個 webview 的回覆）。
 */
import { t } from "../i18n.ts";
import { toast } from "./toast.ts";

export interface AiCommand {
  id: number;
  command: string;
  reason: string;
  cwd: string;
}

type Reply = (id: number, ok: boolean, message: string) => Promise<boolean>;

export class CommandConsent {
  #host: HTMLElement;
  #reply: Reply;
  #focusView: () => void;
  /**
   * 使用者選了「這次開啟期間，這個指令都直接執行」的指令（連同執行位置）。只有一模一樣的指令才不再詢問：
   * 文件裡藏的提示詞讓 AI 改要求別的指令時，仍然會先問。關掉編輯器後恢復詢問。
   */
  #allowed = new Set<string>();
  /** 還在等使用者決定的指令（AI 不再等待時拿掉提示）。 */
  #asking = new Map<number, HTMLElement>();

  constructor(host: HTMLElement, reply: Reply, focusView: () => void) {
    this.#host = host;
    this.#reply = reply;
    this.#focusView = focusView;
  }

  async ask(c: AiCommand): Promise<void> {
    const key = `${c.cwd}\n${c.command}`;
    if (this.#allowed.has(key)) {
      await this.#answer(c.id, true, "使用者已同意。"); // i18n-ignore（回覆給 AI）
      return;
    }
    const bar = document.createElement("div");
    bar.className = "command-consent";
    bar.role = "alertdialog";
    const title = document.createElement("strong");
    title.textContent = t("AI 要在終端機執行指令");
    bar.setAttribute("aria-label", title.textContent);
    const code = document.createElement("code");
    code.className = "command-consent-code";
    code.textContent = c.command;
    const where = document.createElement("span");
    where.className = "command-consent-detail";
    where.textContent = c.reason
      ? t("{reason}。執行位置：{cwd}。執行過程會顯示在下方的終端機。", { reason: c.reason, cwd: c.cwd })
      : t("執行位置：{cwd}。執行過程會顯示在下方的終端機。", { cwd: c.cwd });
    const actions = document.createElement("div");
    actions.className = "command-consent-actions";
    const button = (label: string, cls: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.addEventListener("click", run);
      actions.append(b);
      return b;
    };
    const done = async (ok: boolean, always = false) => {
      this.#asking.delete(c.id);
      bar.remove();
      if (ok && always) this.#allowed.add(key);
      await this.#answer(
        c.id,
        ok,
        ok
          ? "使用者已同意。" // i18n-ignore（回覆給 AI）
          : "使用者拒絕執行這個指令。請不要再要求執行相同的指令，可以改問使用者想怎麼做。", // i18n-ignore（回覆給 AI）
      );
    };
    button(t("執行"), "btn-primary", () => void done(true));
    button(t("這次開啟期間，這個指令都直接執行"), "", () => void done(true, true));
    const deny = button(t("拒絕"), "", () => void done(false));
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void done(false);
      }
    });
    bar.append(title, code, where, actions);
    this.#asking.set(c.id, bar);
    this.#host.prepend(bar);
    // 提示可能在使用者打字時跳出來：預設聚焦「拒絕」，按 Enter 不會誤執行。
    this.#focusView();
    deny.focus();
  }

  /** AI 等太久已經放棄：拿掉提示。 */
  expired(id: number): void {
    const bar = this.#asking.get(id);
    if (!bar) return;
    this.#asking.delete(id);
    bar.remove();
    toast(t("AI 等太久已經放棄，指令沒有執行。"), { duration: 6000 });
  }

  async #answer(id: number, ok: boolean, message: string): Promise<void> {
    const waiting = await this.#reply(id, ok, message).catch(() => false);
    if (ok && !waiting) toast(t("AI 已經不再等待這個指令，所以沒有執行。"), { tone: "error" });
  }
}
