/**
 * 用 SSH 連到 Linux 主機的對話框：直接開啟、編輯主機上的資料夾（透過 SFTP）。
 * 密碼只傳給原生端；留空時用 ssh-agent 或 ~/.ssh 裡的金鑰登入。
 * 第一次連線的主機由原生端用系統的對話框確認主機金鑰（網頁不能代為決定）。
 * 跳板主機要密碼時另外詢問跳板主機的密碼，不會拿目標主機的密碼去試。
 */
import type { Desktop, Folder } from "../desktop.ts";
import { t } from "../i18n.ts";

/** 使用者在系統的對話框沒有信任主機金鑰時，原生端回傳的代碼。 */
export const HOSTKEY_DECLINED = "HOSTKEY_DECLINED";

/** 原生端回傳 `NEED_JUMP_PASSWORD\n帳號@跳板主機:連接埠` 時回傳跳板主機的名稱；其他錯誤回傳 null。 */
export function jumpPasswordHost(message: string): string | null {
  const [tag, host] = message.split("\n");
  return tag === "NEED_JUMP_PASSWORD" ? (host ?? "") : null;
}

export interface SshPrefill {
  host?: string;
  username?: string;
  /** 只需要輸入密碼（重新連線時）。 */
  passwordOnly?: boolean;
  /** 重新連線時的根目錄路徑（`ssh://代號`）。 */
  root?: string;
  /** 重新連線時標題顯示的連線名稱。 */
  name?: string;
  /** 重新連線時跳板主機要密碼：跳板主機的名稱（先只問跳板主機的密碼）。 */
  jump?: string;
}

export class SshDialog {
  #dialog: HTMLDialogElement;
  #d: Desktop;
  #resolve: ((f: Folder | null) => void) | null = null;
  #prefill: SshPrefill = {};

  constructor(d: Desktop) {
    this.#d = d;
    const dialog = document.createElement("dialog");
    dialog.className = "choice dav-dialog";
    dialog.setAttribute("aria-labelledby", "ssh-title");
    const tr = {
      title: t("用 SSH 連線"),
      hint: t("直接開啟 Linux 主機（伺服器、NAS、樹莓派等）上的資料夾。密碼留空時，會用 ssh-agent 或 ~/.ssh 裡的金鑰登入。"),
      host: t("主機"),
      hostExample: t("192.168.1.10 或 server.example.com"),
      port: t("連接埠"),
      username: t("帳號"),
      password: t("密碼"),
      passwordHint: t("留空就用 SSH 金鑰"),
      root: t("遠端資料夾"),
      rootExample: t("~/筆記（留空是家目錄）"),
      advanced: t("進階"),
      keyPath: t("金鑰檔"),
      keyExample: t("~/.ssh/id_ed25519（留空會自動尋找）"),
      jump: t("跳板主機（ProxyJump）"),
      jumpExample: t("帳號@跳板主機:連接埠（不需要就留空）"),
      jumpHint: t("要先連到一台跳板主機才能連到目標主機時填寫。跳板主機用金鑰或 ssh-agent 登入；需要密碼時會另外詢問跳板主機的密碼，不會送出上面的密碼。"),
      remember: t("記住密碼（存在 Windows 認證管理員）"),
      cancel: t("取消"),
      connect: t("連線"),
    };
    dialog.innerHTML = `
      <form method="dialog">
        <h2 id="ssh-title">${tr.title}</h2>
        <p class="dav-hint">${tr.hint}</p>
        <div class="dav-row">
          <label class="dav-grow">${tr.host}<input name="host" required placeholder="${tr.hostExample}" autocomplete="off" spellcheck="false" /></label>
          <label class="dav-port">${tr.port}<input name="port" type="number" min="1" max="65535" placeholder="22" /></label>
        </div>
        <label>${tr.username}<input name="username" autocomplete="username" spellcheck="false" /></label>
        <label class="ssh-password">${tr.password}<input name="password" type="password" placeholder="${tr.passwordHint}" autocomplete="current-password" /></label>
        <label class="ssh-jump-password" hidden><span class="ssh-jump-label"></span><input name="jumpPassword" type="password" autocomplete="off" /></label>
        <label class="ssh-root">${tr.root}<input name="root" placeholder="${tr.rootExample}" spellcheck="false" /></label>
        <details class="dav-advanced">
          <summary>${tr.advanced}</summary>
          <label>${tr.keyPath}<input name="keyPath" placeholder="${tr.keyExample}" spellcheck="false" /></label>
          <label>${tr.jump}<input name="jump" placeholder="${tr.jumpExample}" autocomplete="off" spellcheck="false" /></label>
          <p class="dav-hint">${tr.jumpHint}</p>
        </details>
        <label class="dav-remember"><input name="remember" type="checkbox" checked /> ${tr.remember}</label>
        <p class="dav-error" role="alert" hidden></p>
        <div class="choice-actions">
          <button type="button" class="btn" value="cancel">${tr.cancel}</button>
          <button type="submit" class="btn btn-primary" value="ok">${tr.connect}</button>
        </div>
      </form>`;
    const form = dialog.querySelector("form")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.#submit();
    });
    dialog.querySelector("button[value=cancel]")!.addEventListener("click", () => this.#finish(null));
    dialog.addEventListener("cancel", () => this.#finish(null));
    document.body.append(dialog);
    this.#dialog = dialog;
    // 換了跳板主機：剛才輸入的跳板主機密碼不能送到另一台。
    this.#form().jump.addEventListener("input", () => this.#askJump(null));
  }

  /** 開啟對話框；連線成功時回傳遠端資料夾，取消時回傳 null。 */
  open(prefill: SshPrefill = {}): Promise<Folder | null> {
    this.#prefill = prefill;
    const f = this.#form();
    f.host.value = prefill.host ?? "";
    f.username.value = prefill.username ?? "";
    f.password.value = "";
    this.#askJump(prefill.jump ?? null);
    const only = !!prefill.passwordOnly;
    f.host.readOnly = f.username.readOnly = only;
    for (const el of this.#dialog.querySelectorAll<HTMLElement>(".dav-port, .ssh-root, .dav-advanced")) el.hidden = only;
    // 重新連線時只缺跳板主機的密碼：先不顯示目標主機的密碼欄（之後需要時再顯示）。
    this.#row(".ssh-password").hidden = only && prefill.jump !== undefined;
    f.password.placeholder = only ? "" : t("留空就用 SSH 金鑰");
    this.#dialog.querySelector("h2")!.textContent = only ? t("重新連線到 {host}", { host: prefill.name ?? prefill.host ?? "" }) : t("用 SSH 連線");
    this.#error("");
    this.#dialog.showModal();
    (prefill.jump !== undefined ? f.jumpPassword : only ? f.password : f.host).focus();
    return new Promise((resolve) => (this.#resolve = resolve));
  }

  #form() {
    const q = (name: string) => this.#dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    return {
      host: q("host"),
      port: q("port"),
      username: q("username"),
      password: q("password"),
      jumpPassword: q("jumpPassword"),
      root: q("root"),
      keyPath: q("keyPath"),
      jump: q("jump"),
      remember: q("remember"),
    };
  }

  #row(selector: string): HTMLElement {
    return this.#dialog.querySelector<HTMLElement>(selector)!;
  }

  /** 顯示跳板主機的密碼欄（標明是哪一台）；`null` 時收起來並清掉。 */
  #askJump(host: string | null): void {
    const row = this.#row(".ssh-jump-password");
    const input = this.#form().jumpPassword;
    if (host === null || row.dataset.host !== host) input.value = "";
    row.hidden = host === null;
    row.dataset.host = host ?? "";
    row.querySelector(".ssh-jump-label")!.textContent = t("跳板主機 {host} 的密碼", { host: host ?? "" });
  }

  #error(message: string): void {
    const el = this.#dialog.querySelector<HTMLElement>(".dav-error")!;
    el.hidden = !message;
    el.textContent = message;
  }

  async #submit(): Promise<void> {
    const f = this.#form();
    const submit = this.#dialog.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    submit.textContent = t("連線中…");
    this.#error("");
    // 跳板主機的密碼只在原生端要求過之後才送出。
    const jumpPassword = this.#row(".ssh-jump-password").hidden ? undefined : f.jumpPassword.value || undefined;
    try {
      const folder =
        this.#prefill.passwordOnly && this.#prefill.root
          ? await this.#d.reopenFolder(this.#prefill.root, f.password.value || undefined, f.remember.checked, jumpPassword)
          : await this.#d.sshConnect({
              host: f.host.value.trim(),
              port: f.port.value ? Number(f.port.value) : null,
              username: f.username.value.trim(),
              password: f.password.value,
              jumpPassword: jumpPassword ?? "",
              keyPath: f.keyPath.value.trim(),
              jump: f.jump.value.trim(),
              root: f.root.value.trim(),
              remember: f.remember.checked,
            });
      this.#finish(folder);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === HOSTKEY_DECLINED) {
        this.#error(t("沒有信任這台主機的金鑰，已取消連線。"));
        return;
      }
      const jump = jumpPasswordHost(message);
      if (jump !== null) {
        this.#askJump(jump);
        this.#error(t("跳板主機「{host}」需要密碼。請輸入跳板主機的密碼（不會使用目標主機的密碼）。", { host: jump }));
        f.jumpPassword.focus();
        return;
      }
      if (message === "NEED_PASSWORD") {
        this.#row(".ssh-password").hidden = false;
        this.#error(t("用金鑰登入失敗，請輸入密碼（或金鑰的密語）。"));
        f.password.focus();
        return;
      }
      this.#error(message);
    } finally {
      submit.disabled = false;
      submit.textContent = t("連線");
    }
  }

  #finish(folder: Folder | null): void {
    if (this.#dialog.open) this.#dialog.close();
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(folder);
  }
}
