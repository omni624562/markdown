/**
 * 連線到 WebDAV 伺服器（Synology、QNAP、Nextcloud…）的對話框。
 * 密碼只傳給原生端；選「記住密碼」時存在 Windows 認證管理員。
 */
import type { Desktop, Folder } from "../desktop.ts";
import { choose } from "./choice.ts";

export interface DavPrefill {
  url?: string;
  username?: string;
  /** 只需要輸入密碼（重新連線時）。 */
  passwordOnly?: boolean;
  id?: string;
}

export class WebDavDialog {
  #dialog: HTMLDialogElement;
  #d: Desktop;
  #resolve: ((f: Folder | null) => void) | null = null;
  #prefill: DavPrefill = {};

  constructor(d: Desktop) {
    this.#d = d;
    const dialog = document.createElement("dialog");
    dialog.className = "choice dav-dialog";
    dialog.setAttribute("aria-labelledby", "dav-title");
    dialog.innerHTML = `
      <form method="dialog">
        <h2 id="dav-title">連線到 WebDAV</h2>
        <p class="dav-hint">直接開啟 NAS（Synology、QNAP、Nextcloud 等）上的資料夾。Synology 預設的 HTTPS 連接埠是 5006。</p>
        <label>網址<input name="url" type="url" required placeholder="https://nas.local:5006/筆記/" autocomplete="url" spellcheck="false" /></label>
        <label>帳號<input name="username" required autocomplete="username" spellcheck="false" /></label>
        <label>密碼<input name="password" type="password" required autocomplete="current-password" /></label>
        <label class="dav-remember"><input name="remember" type="checkbox" checked /> 記住密碼（存在 Windows 認證管理員）</label>
        <p class="dav-error" role="alert" hidden></p>
        <div class="choice-actions">
          <button type="button" class="btn" value="cancel">取消</button>
          <button type="submit" class="btn btn-primary" value="ok">連線</button>
        </div>
      </form>`;
    const form = dialog.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.#submit(false);
    });
    dialog.querySelector("button[value=cancel]")!.addEventListener("click", () => this.#finish(null));
    dialog.addEventListener("cancel", () => this.#finish(null));
    document.body.append(dialog);
    this.#dialog = dialog;
  }

  /** 開啟對話框；連線成功時回傳遠端資料夾，取消時回傳 null。 */
  open(prefill: DavPrefill = {}): Promise<Folder | null> {
    this.#prefill = prefill;
    const f = this.#form();
    f.url.value = prefill.url ?? "";
    f.username.value = prefill.username ?? "";
    f.password.value = "";
    f.url.readOnly = f.username.readOnly = !!prefill.passwordOnly;
    this.#dialog.querySelector("h2")!.textContent = prefill.passwordOnly ? "重新連線到 WebDAV" : "連線到 WebDAV";
    this.#error("");
    this.#dialog.showModal();
    (prefill.passwordOnly ? f.password : f.url).focus();
    return new Promise((resolve) => (this.#resolve = resolve));
  }

  #form() {
    const q = (name: string) => this.#dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    return { url: q("url"), username: q("username"), password: q("password"), remember: q("remember") };
  }

  #error(message: string): void {
    const el = this.#dialog.querySelector<HTMLElement>(".dav-error")!;
    el.hidden = !message;
    el.textContent = message;
  }

  async #submit(allowHttp: boolean): Promise<void> {
    const f = this.#form();
    const submit = this.#dialog.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    submit.textContent = "連線中…";
    this.#error("");
    try {
      const folder = this.#prefill.passwordOnly && this.#prefill.id
        ? await this.#d.reopenFolder(`webdav://${this.#prefill.id}`, f.password.value, f.remember.checked)
        : await this.#d.davConnect(f.url.value, f.username.value.trim(), f.password.value, f.remember.checked, allowHttp);
      this.#finish(folder);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "HTTP_CONFIRM") {
        // 對話框疊在對話框上：先關掉，問完再打開。
        this.#dialog.close();
        const ok = await choose(
          "要用沒有加密的 HTTP 連線嗎？",
          "HTTP 不會加密，同一個網路上的人可能看到你的密碼與筆記內容。建議改用 HTTPS（Synology 預設是 5006 連接埠）。只在家裡或公司的區域網路中使用。",
          [
            { id: "use", label: "仍要用 HTTP 連線", danger: true },
            { id: "cancel", label: "取消", primary: true },
          ],
        );
        this.#dialog.showModal();
        if (ok === "use") await this.#submit(true);
        return;
      }
      this.#error(message);
    } finally {
      submit.disabled = false;
      submit.textContent = "連線";
    }
  }

  #finish(folder: Folder | null): void {
    if (this.#dialog.open) this.#dialog.close();
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(folder);
  }
}
