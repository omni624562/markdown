/**
 * 可以下載儲存庫的地方（GitHub、Azure DevOps）：專案切換器、專案總覽、檔案面板與「☰」選單共用。
 * 還沒登入 GitHub、還沒連線 Azure DevOps 時不停用（點下去就是登入，或打開設定的連線頁），
 * 只在名稱旁邊註明狀態；登入、連線後改成帳號名稱。帳號還沒讀到時不註明，免得已經登入的人看到一閃而過的「還沒登入」。
 */
import { t } from "../i18n.ts";
import type { RepoSource } from "../ui/project-ui.ts";
import { app } from "./context.ts";

/** GitHub 的狀態：還沒登入，或登入的帳號。 */
export function githubNote(): string | undefined {
  const github = app.github;
  if (github?.account) return github.account.login;
  return github?.loaded ? t("還沒登入") : undefined;
}

/** Azure DevOps 的狀態：還沒連線，或連線的帳號。 */
export function adoNote(): string | undefined {
  const ado = app.ado;
  if (ado?.account) return ado.account.name;
  return ado?.loaded ? t("還沒連線") : undefined;
}

const NOTES: Record<string, () => string | undefined> = { github: githubNote, ado: adoNote };

export function repoSources(): RepoSource[] {
  const { github, ado } = app;
  return [
    ...(github ? [{ id: "github", title: t("GitHub：下載儲存庫…"), icon: "github", note: githubNote(), run: () => void github.openRepo() }] : []),
    ...(ado ? [{ id: "ado", title: t("Azure DevOps：下載儲存庫…"), icon: "briefcase-business", note: adoNote(), run: () => void ado.openRepo() }] : []),
  ];
}

/** 檔案面板按鈕上的狀態（放在名稱下面）；登入狀態改了用 {@link refreshRepoNotes} 更新。 */
export function repoNoteEl(source: RepoSource): HTMLElement {
  const el = document.createElement("small");
  el.className = "repo-note";
  el.dataset.repoNote = source.id;
  el.textContent = source.note ?? "";
  el.hidden = !source.note;
  return el;
}

/** 帳號讀到了，或登入、登出、連線、中斷連線：更新畫面上已經列出的狀態。 */
export function refreshRepoNotes(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-repo-note]")) {
    const note = NOTES[el.dataset.repoNote!]?.();
    el.textContent = note ?? "";
    el.hidden = !note;
  }
}
