/**
 * 新專案（只有桌面版）：在電腦上建立一個新資料夾當成專案開啟。
 * 對話框填名稱、位置（預設「文件」，「瀏覽…」可以換）、一開始放什麼（空白：README.md；筆記本：再加每日筆記、
 * assets 資料夾；COMET 專案：建立後在終端機執行 `comet setup`）、要不要建立 Git 儲存庫、顏色；
 * 建立後切換到新專案並開啟 README.md。
 *
 * 新 COMET 專案：`comet setup` 是互動式的環境設定，在內嵌終端機（工作目錄就是新專案）執行，使用者照畫面的指示輸入。
 * 主畫面不能直接寫入終端機，只能送固定的要求（見 desktop/src/ai/view.rs 的 `Request::CometSetup`）。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { PROJECT_COLORS } from "../projects.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";

/** Windows 不能當檔名的名稱（不分大小寫，也不能加副檔名）。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 專案名稱（也是資料夾名稱）不能用時回傳原因（和 desktop/src/new_project.rs 的 invalid_name 一樣）。 */
export function invalidProjectName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return t("請輸入專案名稱");
  if ([...name].length > 120) return t("專案名稱太長了");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字元也不能當檔名
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return t("專案名稱不能有這些字元：\\ / : * ? \" < > |");
  if (name.endsWith(".")) return t("專案名稱不能用「.」結尾");
  if (RESERVED.test(name)) return t("「{name}」是 Windows 保留的名稱，請換一個", { name });
  return null;
}

/** 新資料夾的完整路徑（照位置用的分隔符號）。 */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? parent + name : parent + sep + name;
}

let dialog: HTMLDialogElement | null = null;
/** 這台電腦有沒有 COMET CLI（PATH 裡或固定的安裝位置；每次打開對話框時重新檢查：使用者可能剛裝好）。 */
let cometFound: Promise<boolean> = Promise.resolve(false);

/** 一開始放什麼。 */
export type ProjectKind = "blank" | "notebook" | "comet";

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "choice project-edit new-project";
  d.setAttribute("aria-labelledby", "np-title");
  const colors = [{ id: "", label: t("不設定") }, ...PROJECT_COLORS]
    .map(
      (c) =>
        `<label class="pe-color" title="${c.label}"><input type="radio" name="color" value="${c.id}" aria-label="${c.label}" /><span class="project-dot"${c.id ? ` data-color="${c.id}"` : ""}></span></label>`,
    )
    .join("");
  const tr = {
    title: t("新專案"),
    hint: t("在電腦上建立一個新資料夾，當成專案開啟。"),
    name: t("專案名稱"),
    where: t("放在哪裡"),
    browse: t("瀏覽…"),
    content: t("一開始放什麼"),
    blank: t("空白：只有一份 README.md"),
    notebook: t("筆記本：README.md、每日筆記、assets（圖片）資料夾"),
    comet: t("COMET 專案：README.md，建立後在終端機執行 comet setup"),
    cometMissing: t("這台電腦找不到 comet 指令。專案照樣會建立，裝好 COMET CLI 之後，在終端機執行 comet setup 就好。"),
    git: t("同時建立 Git 儲存庫（之後可以推送到 GitHub、Azure DevOps）"),
    color: t("顏色"),
    cancel: t("取消"),
    create: t("建立並開啟"),
  };
  d.innerHTML = `
    <form method="dialog">
      <h2 id="np-title">${tr.title}</h2>
      <p class="pe-path">${tr.hint}</p>
      <label>${tr.name}<input name="name" maxlength="120" spellcheck="false" autocomplete="off" /></label>
      <label>${tr.where}
        <span class="np-where"><input name="parent" readonly /><button type="button" class="btn np-browse">${tr.browse}</button></span>
      </label>
      <div class="np-status"><p class="np-preview"></p><p class="dav-error" role="alert" hidden></p></div>
      <fieldset class="np-content"><legend>${tr.content}</legend>
        <label class="pe-check"><input type="radio" name="content" value="blank" checked /> ${tr.blank}</label>
        <label class="pe-check"><input type="radio" name="content" value="notebook" /> ${tr.notebook}</label>
        <label class="pe-check"><input type="radio" name="content" value="comet" /> ${tr.comet}</label>
        <p class="np-warn" hidden>${tr.cometMissing}</p>
      </fieldset>
      <label class="pe-check"><input type="checkbox" name="git" checked /> ${tr.git}</label>
      <fieldset class="pe-colors"><legend>${tr.color}</legend>${colors}</fieldset>
      <div class="choice-actions">
        <button type="button" class="btn" value="cancel">${tr.cancel}</button>
        <button type="submit" class="btn btn-primary">${tr.create}</button>
      </div>
    </form>`;
  document.body.append(d);
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const name = q<HTMLInputElement>("input[name=name]");
  const parent = q<HTMLInputElement>("input[name=parent]");
  const preview = q(".np-preview");
  const error = q(".dav-error");
  const submit = q<HTMLButtonElement>("button[type=submit]");
  const showError = (message: string) => {
    error.textContent = message;
    error.hidden = !message;
  };
  /** 名稱、位置換了：更新會建立的路徑，名稱不能用時說原因、不能按建立。 */
  const update = () => {
    const why = name.value ? invalidProjectName(name.value) : null;
    showError(why ?? "");
    preview.textContent = name.value.trim() && parent.value && !why ? t("會建立「{path}」", { path: joinPath(parent.value, name.value.trim()) }) : "";
    submit.disabled = !name.value.trim() || !parent.value || !!why;
  };
  name.addEventListener("input", update);
  for (const r of d.querySelectorAll<HTMLInputElement>("input[name=content]")) r.addEventListener("change", () => void syncKind(d));
  q(".np-browse").addEventListener("click", () => {
    void desktop!
      .pickProjectParent()
      .then((picked) => {
        if (picked) parent.value = picked;
        update();
      })
      .catch((e) => showError(String(e)));
  });
  q("button[value=cancel]").addEventListener("click", () => d.close());
  q("form").addEventListener("submit", (e) => {
    e.preventDefault();
    submit.disabled = true;
    const projectName = name.value.trim();
    const color = d.querySelector<HTMLInputElement>("input[name=color]:checked")?.value || null;
    const comet = kindOf(d) === "comet";
    void desktop!
      .createProject({
        parent: parent.value,
        name: projectName,
        notebook: q<HTMLInputElement>("input[value=notebook]").checked,
        git: q<HTMLInputElement>("input[name=git]").checked,
        dailyFolder: app.settings.value.dailyFolder,
      })
      .then(async (folder) => {
        d.close();
        // 先存顏色再切換：側邊欄與狀態列的專案名稱一出現就是選的顏色。
        if (color) await desktop!.projectUpdate(folder.path, { name: null, color, group: null, pinned: false }).catch(() => {});
        await app.setWorkspace(folder);
        app.showPanel("files");
        await app.openPath(joinPath(folder.path, "README.md"));
        if (!comet) {
          toast(t("已建立專案「{name}」", { name: projectName }), { tone: "success" });
        } else if (await cometFound) {
          // 終端機的工作目錄是目前的專案（剛切換過去的新專案）。
          app.terminal?.runCometSetup();
          toast(t("已建立專案「{name}」，請在下方的終端機照畫面的指示完成 comet setup。", { name: projectName }), { tone: "success", duration: 10000 });
        } else {
          toast(t("已建立專案「{name}」。這台電腦找不到 comet 指令，裝好 COMET CLI 之後，在終端機執行 comet setup。", { name: projectName }), {
            duration: 15000,
          });
        }
      })
      .catch((e) => {
        showError(e instanceof Error ? e.message : String(e));
        submit.disabled = false;
      });
  });
  return d;
}

function kindOf(d: HTMLDialogElement): ProjectKind {
  return (d.querySelector<HTMLInputElement>("input[name=content]:checked")?.value as ProjectKind | undefined) ?? "blank";
}

/** 選了 COMET 專案時，標題與說明跟著換；找不到 comet 指令時提醒。 */
async function syncKind(d: HTMLDialogElement): Promise<void> {
  const comet = kindOf(d) === "comet";
  d.querySelector("#np-title")!.textContent = comet ? t("新 COMET 專案") : t("新專案");
  d.querySelector(".pe-path")!.textContent = comet
    ? t("在電腦上建立一個新資料夾，接著在終端機執行 comet setup，照畫面的指示輸入資料。")
    : t("在電腦上建立一個新資料夾，當成專案開啟。");
  const warn = d.querySelector<HTMLElement>(".np-warn")!;
  warn.hidden = true;
  if (comet && !(await cometFound) && kindOf(d) === "comet") warn.hidden = false;
}

/** 打開新專案的對話框（`kind` 是預先選好的「一開始放什麼」；「新 COMET 專案…」選 COMET 專案）。 */
export async function newProject(kind: ProjectKind = "blank"): Promise<void> {
  if (!desktop) return;
  cometFound = desktop.cometInstalled().catch(() => false);
  dialog ??= build();
  const d = dialog;
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  q<HTMLInputElement>("input[name=name]").value = "";
  const parent = q<HTMLInputElement>("input[name=parent]");
  if (!parent.value) parent.value = (await desktop.projectDefaultParent().catch(() => null)) ?? "";
  q<HTMLInputElement>(`input[name=content][value=${kind}]`).checked = true;
  void syncKind(d);
  q<HTMLInputElement>("input[name=git]").checked = true;
  q<HTMLInputElement>("input[name=color][value='']").checked = true;
  q<HTMLInputElement>("input[name=name]").dispatchEvent(new Event("input"));
  d.showModal();
  q<HTMLInputElement>("input[name=name]").focus();
}
