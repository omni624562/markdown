/**
 * 用 SSH 連到 Linux 主機的對話框：直接開啟、編輯主機上的資料夾（透過 SFTP）。
 * 密碼只傳給原生端；留空時用 ssh-agent 或 ~/.ssh 裡的金鑰登入。
 */
import type { Desktop, Folder } from "../desktop.ts";
import { t } from "../i18n.ts";
import { choose } from "./choice.ts";

export interface SshPrefill {
  host?: string;
  username?: string;
  /** 只需要輸入密碼（重新連線時）。 */
  passwordOnly?: boolean;
  /** 重新連線時的根目錄路徑（`ssh://代號`）。 */
  root?: string;
  /** 重新連線時標題顯示的連線名稱。 */
  name?: string;
}

/**
 * 原生端回傳 `HOSTKEY_UNKNOWN\n演算法\n指紋` 時，請使用者確認第一次連線的主機。
 * 確認時回傳指紋，取消或不是這種錯誤時回傳 null。
 */
export async function confirmHostKey(message: string, host: string): Promise<string | null> {
  const [tag, algo, fp] = message.split("\n");
  if (tag !== "HOSTKEY_UNKNOWN" || !fp) return null;
  const ok = await choose(
    t("第一次連線到這台主機"),
    t("無法確認「{host}」的身分。請核對下面的主機金鑰指紋和伺服器上的一致（在伺服器上執行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 可以看到）。信任之後會記在 ~/.ssh/known_hosts，下次不再詢問。", { host }),
    [
      { id: "trust", label: t("信任並連線"), primary: true },
      { id: "cancel", label: t("取消") },
    ],
    { code: `${algo}\n${fp}` },
  );
  return ok === "trust" ? fp : null;
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
        <label>${tr.password}<input name="password" type="password" placeholder="${tr.passwordHint}" autocomplete="current-password" /></label>
        <label class="ssh-root">${tr.root}<input name="root" placeholder="${tr.rootExample}" spellcheck="false" /></label>
        <details class="dav-advanced">
          <summary>${tr.advanced}</summary>
          <label>${tr.keyPath}<input name="keyPath" placeholder="${tr.keyExample}" spellcheck="false" /></label>
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
  }

  /** 開啟對話框；連線成功時回傳遠端資料夾，取消時回傳 null。 */
  open(prefill: SshPrefill = {}): Promise<Folder | null> {
    this.#prefill = prefill;
    const f = this.#form();
    f.host.value = prefill.host ?? "";
    f.username.value = prefill.username ?? "";
    f.password.value = "";
    const only = !!prefill.passwordOnly;
    f.host.readOnly = f.username.readOnly = only;
    for (const el of this.#dialog.querySelectorAll<HTMLElement>(".dav-port, .ssh-root, .dav-advanced")) el.hidden = only;
    f.password.placeholder = only ? "" : t("留空就用 SSH 金鑰");
    this.#dialog.querySelector("h2")!.textContent = only ? t("重新連線到 {host}", { host: prefill.name ?? prefill.host ?? "" }) : t("用 SSH 連線");
    this.#error("");
    this.#dialog.showModal();
    (only ? f.password : f.host).focus();
    return new Promise((resolve) => (this.#resolve = resolve));
  }

  #form() {
    const q = (name: string) => this.#dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    return {
      host: q("host"),
      port: q("port"),
      username: q("username"),
      password: q("password"),
      root: q("root"),
      keyPath: q("keyPath"),
      remember: q("remember"),
    };
  }

  #error(message: string): void {
    const el = this.#dialog.querySelector<HTMLElement>(".dav-error")!;
    el.hidden = !message;
    el.textContent = message;
  }

  async #submit(trust?: string): Promise<void> {
    const f = this.#form();
    const submit = this.#dialog.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submit.disabled = true;
    submit.textContent = t("連線中…");
    this.#error("");
    try {
      const folder =
        this.#prefill.passwordOnly && this.#prefill.root
          ? await this.#d.reopenFolder(this.#prefill.root, f.password.value || undefined, f.remember.checked, trust)
          : await this.#d.sshConnect({
              host: f.host.value.trim(),
              port: f.port.value ? Number(f.port.value) : null,
              username: f.username.value.trim(),
              password: f.password.value,
              keyPath: f.keyPath.value.trim(),
              root: f.root.value.trim(),
              remember: f.remember.checked,
              trust,
            });
      this.#finish(folder);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("HOSTKEY_UNKNOWN")) {
        // 對話框疊在對話框上：先關掉，問完再打開。
        this.#dialog.close();
        const fp = await confirmHostKey(message, f.host.value.trim());
        this.#dialog.showModal();
        if (fp) await this.#submit(fp);
        return;
      }
      if (message === "NEED_PASSWORD") {
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
