/**
 * 已經有的專案設定成 COMET 專案：先建好專案、過一陣子才要用 COMET 時（「☰」→「專案」→「設定成 COMET 專案…」）。
 * 已經是 COMET 專案時是「重新設定 COMET…」（例如換 Sprint 或指派對象）。
 *
 * 對話框只有「COMET 設定」一張（和新專案對話框右邊同一張，見 app/comet-setup.ts）。按「開始設定」後在
 * 專案資料夾背景執行 `comet setup`，進度與完成頁和新建時一樣，只是沒有建立資料夾、Git 儲存庫這兩步。
 * 完成後重新讀專案清單，專案名稱旁邊出現「COMET」小標籤。
 */
import { desktop, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";
import { cometPresent } from "./comet-presence.ts";
import { type CometForm, cometForm, cometSetupRunning, runCometSetup } from "./comet-setup.ts";
import { app } from "./context.ts";

let dialog: HTMLDialogElement | null = null;
let form: CometForm;

/** 目前開著的專案可以設定 COMET：本機資料夾（遠端資料夾不行），而且這台電腦有 COMET。 */
export function cometSetupAvailable(): boolean {
  return !!desktop && !!app.workspaceRoot && !isRemote(app.workspaceRoot.path) && cometPresent();
}

/** 目前的專案已經是 COMET 專案（資料夾裡有 `.comet.json`）。 */
export function isCometProject(): boolean {
  return !!app.projectUi?.current?.comet;
}

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "choice project-edit new-project comet-only";
  d.setAttribute("aria-labelledby", "cp-title");
  d.innerHTML = `
    <form method="dialog">
      <h2 id="cp-title"></h2>
      <p class="pe-path cp-hint"></p>
      <p class="cp-warn" hidden></p>
      <section class="np-card np-comet"></section>
      <div class="choice-actions">
        <button type="button" class="btn" value="cancel"></button>
        <button type="submit" class="btn btn-primary"></button>
      </div>
    </form>
    <div class="np-progress" hidden></div>`;
  document.body.append(d);
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const submit = q<HTMLButtonElement>("button[type=submit]");
  q("button[value=cancel]").textContent = t("取消");
  submit.textContent = t("開始設定");
  form = cometForm(q(".np-comet"), () => (submit.disabled = !form.request()));
  q("button[value=cancel]").addEventListener("click", () => d.close());
  q("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const req = form.request();
    const root = app.workspaceRoot;
    if (!req || !root) return;
    const name = app.projectUi?.current?.label ?? root.name;
    const summary = [...form.summary(), { label: t("資料夾"), value: root.path }];
    q("form").hidden = true;
    q(".np-progress").hidden = false;
    void runCometSetup(d, q(".np-progress"), { ...req, dir: root.path }, { name, git: false, summary, existing: true }).then(async (ok) => {
      if (!ok) return;
      // 專案名稱旁邊的「COMET」小標籤、選單裡的「重新設定 COMET…」跟著更新。
      await app.projectUi?.refresh();
      await app.renderProjectName();
    });
  });
  return d;
}

/** 打開「設定成 COMET 專案」（已經是 COMET 專案時是「重新設定 COMET」）的對話框。 */
export function openCometProjectSetup(): void {
  if (!cometSetupAvailable()) return;
  // 同一時間只能有一個 comet setup（例如新專案的設定按了「在背景繼續」還沒完成）。
  if (cometSetupRunning()) {
    toast(t("另一個 COMET 設定還在進行中，完成後再試一次。"));
    return;
  }
  dialog ??= build();
  const d = dialog;
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const root = app.workspaceRoot!;
  const name = app.projectUi?.current?.label ?? root.name;
  const again = isCometProject();
  q("form").hidden = false;
  q(".np-progress").hidden = true;
  d.setAttribute("aria-labelledby", "cp-title");
  q("#cp-title").textContent = again ? t("重新設定 COMET") : t("設定成 COMET 專案");
  q(".cp-hint").textContent = again
    ? t("用新的設定在「{name}」資料夾再執行一次 comet setup，例如換 Sprint 或指派對象。", { name })
    : t("在「{name}」資料夾執行 comet setup，設定好就是 COMET 專案。", { name });
  // 重新設定時 comet 可能依新的規則改寫它產生的檔案（例如 AGENTS.md）：手動改過的話先留備份。
  const warn = q(".cp-warn");
  warn.hidden = !again;
  warn.replaceChildren(icon("info"), t("comet 可能會依新的規則更新 AGENTS.md 等它產生的檔案。如果你手動改過，請先提交到 Git 或留個備份。"));
  q<HTMLButtonElement>("button[type=submit]").disabled = true;
  void form.load().then(() => (q<HTMLButtonElement>("button[type=submit]").disabled = !form.request()));
  d.showModal();
}
